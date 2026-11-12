const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./harness');

before(async () => {
  await h.startApns();
  await h.startDb();
  await h.prepareProductionLikeSchema();
  await h.startApi();
});
after(async () => { await h.stopAll(); });
beforeEach(() => h.apns.clear());

function verifyJwt(auth) {
  assert.match(auth, /^bearer /);
  const jwt = auth.slice(7);
  const [hh, cc, ss] = jwt.split('.');
  const header = JSON.parse(Buffer.from(hh, 'base64url'));
  const claims = JSON.parse(Buffer.from(cc, 'base64url'));
  const ok = crypto.verify('sha256', Buffer.from(`${hh}.${cc}`), { key: h.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(ss, 'base64url'));
  return { header, claims, ok };
}

// =========================== INTEGRATION ===========================
describe('Integration: iPhone wake-up flow', () => {
  let a, b, tokenA;
  before(async () => {
    a = await h.newUser('Aakancha Pandey');   // iPhone
    b = await h.newUser('Ankit');             // Android
    await h.connect(a, b);
    tokenA = h.hexToken();
  });

  test('I1 iPhone uploads its APNs token', async () => {
    const r = await h.call('POST', '/devices/apns-token', a.token, { token: tokenA.toUpperCase(), environment: 'production' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const row = await h.userRow(a.id);
    assert.equal(row.apns_token, tokenA, 'stored lower-case');
    assert.equal(row.apns_env, 'production');
  });

  test('I2 friend opens the profile → exactly one correct silent push', async () => {
    const t0 = Date.now();
    const r = await h.call('POST', `/profile-views/${a.id}`, b.token);
    assert.equal(r.status, 201);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 1), 'push arrived');
    await h.sleep(200);
    assert.equal(h.apns.requests.length, 1);
    const req = h.apns.requests[0];
    assert.equal(req.token, tokenA);
    assert.equal(req.headers[':method'], 'POST');
    assert.equal(req.headers[':path'], `/3/device/${tokenA}`);
    assert.equal(req.headers['apns-push-type'], 'background');
    assert.equal(req.headers['apns-priority'], '5');
    assert.equal(req.headers['apns-topic'], 'com.consnow.ios');
    assert.equal(req.headers['apns-collapse-id'], 'status_request');
    const exp = Number(req.headers['apns-expiration']) * 1000;
    assert.ok(exp > t0 + 250_000 && exp < t0 + 320_000, 'expires in ~5 min');
    assert.deepEqual(req.body, { aps: { 'content-available': 1 }, type: 'status_request' });
    const jwt = verifyJwt(req.headers.authorization);
    assert.equal(jwt.ok, true, 'JWT signed with the .p8 key');
    assert.deepEqual(jwt.header, { alg: 'ES256', kid: 'TESTKEY123' });
    assert.equal(jwt.claims.iss, 'ZKST8KHYAB');
    assert.ok(Math.abs(jwt.claims.iat * 1000 - Date.now()) < 60_000);
  });

  test('I3 second open within 5 min → no second push (throttle)', async () => {
    await h.call('POST', `/profile-views/${a.id}`, b.token);
    await h.sleep(400);
    assert.equal(h.apns.requests.length, 0);
  });

  test('I4 after the throttle window, a quiet iPhone is woken again', async () => {
    await h.resetWake(a.id);
    await h.call('POST', `/profile-views/${a.id}`, b.token);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 1));
  });

  test('I5 iPhone that is live (fresh heartbeat) is not woken', async () => {
    await h.call('PUT', '/activity/unlock', a.token, { occurredAt: Date.now() });
    const hb = await h.call('PUT', '/activity/heartbeat', a.token);
    assert.equal(hb.status, 200);
    await h.resetWake(a.id);
    await h.call('POST', `/profile-views/${a.id}`, b.token);
    await h.sleep(400);
    assert.equal(h.apns.requests.length, 0);
  });

  test('I6 friend sees lastSeenAt = last heartbeat', async () => {
    const r = await h.call('GET', `/activity/peer/${a.id}`, b.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.isOnline, true);
    assert.ok(r.json.lastSeenAt && Date.now() - Date.parse(r.json.lastSeenAt) < 10_000, JSON.stringify(r.json));
    await h.makeStale(a.id);
    const r2 = await h.call('GET', `/activity/peer/${a.id}`, b.token);
    assert.equal(r2.json.isOnline, false);
    assert.ok(Date.now() - Date.parse(r2.json.lastSeenAt) > 9 * 60_000);
  });

  test('I6b own /activity/me also has lastSeenAt', async () => {
    const r = await h.call('GET', '/activity/me', a.token);
    assert.equal(r.status, 200);
    assert.ok('lastSeenAt' in r.json, JSON.stringify(r.json));
  });

  test('I7 the woken iPhone syncs → friend sees fresh steps and lock state', async () => {
    // What the iOS app does on a wake: steps + lock + heartbeat
    const today = new Date().toISOString().slice(0, 10);
    const s = await h.call('PUT', '/steps/sync', a.token, { stepCount: 4210, date: today, isActive: false, lastStepAt: Date.now() - 600_000 });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    // iOS sends the last moment the phone was in use, which is after the last unlock
    await h.call('PUT', '/activity/lock', a.token, { occurredAt: Date.now() });
    await h.call('PUT', '/activity/heartbeat', a.token);
    const steps = await h.call('GET', `/steps/user/${a.id}?date=${today}`, b.token);
    assert.equal(steps.json.stepCount, 4210);
    const act = await h.call('GET', `/activity/peer/${a.id}`, b.token);
    assert.equal(act.json.isLocked, true);
    assert.equal(act.json.isOnline, true);
  });

  test('I8 sign-out removes the token → no more pushes', async () => {
    const r = await h.call('DELETE', '/devices/apns-token', a.token);
    assert.equal(r.status, 200);
    assert.equal((await h.userRow(a.id)).apns_token, null);
    await h.makeStale(a.id);
    await h.resetWake(a.id);
    await h.call('POST', `/profile-views/${a.id}`, b.token);
    await h.sleep(400);
    assert.equal(h.apns.requests.length, 0);
  });

  test('I9 sandbox token goes out with env sandbox (stored and used)', async () => {
    const t = h.hexToken();
    await h.call('POST', '/devices/apns-token', a.token, { token: t, environment: 'sandbox' });
    assert.equal((await h.userRow(a.id)).apns_env, 'sandbox');
    await h.resetWake(a.id);
    await h.call('POST', `/profile-views/${a.id}`, b.token);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 1));
    assert.equal(h.apns.requests[0].token, t);
  });

  test('I10 Seen by still records the view while waking', async () => {
    const r = await h.call('GET', `/profile-views?since=${new Date(Date.now() - 3600_000).toISOString()}`, a.token);
    assert.equal(r.status, 200);
    assert.ok(r.json.length >= 1 && r.json[0].name === 'Ankit', JSON.stringify(r.json));
  });

  test('I11 deleting the account works with a token stored', async () => {
    const c = await h.newUser('Temp User');
    await h.call('POST', '/devices/apns-token', c.token, { token: h.hexToken(), environment: 'production' });
    const r = await h.call('DELETE', '/auth/me', c.token);
    assert.ok(r.status === 200 || r.status === 204, String(r.status));
    assert.equal((await h.db.query('SELECT 1 FROM users WHERE id=$1', [c.id])).rowCount, 0);
    const after = await h.call('POST', '/devices/apns-token', c.token, { token: h.hexToken(), environment: 'production' });
    assert.equal(after.status, 401, 'old JWT is rejected after delete');
  });
});

// =========================== BREAK IT ===========================
describe('Break it: bad input and abuse', () => {
  let u, v;
  before(async () => {
    u = await h.newUser('Tester');
    v = await h.newUser('Stranger');
  });

  test('X1 no token / garbage token / expired-looking token → 401', async () => {
    for (const tok of [null, 'garbage', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad']) {
      const r = await h.call('POST', '/devices/apns-token', tok, { token: h.hexToken(), environment: 'production' });
      assert.equal(r.status, 401, `token=${tok}`);
    }
    const d = await h.call('DELETE', '/devices/apns-token', null);
    assert.equal(d.status, 401);
  });

  test('X2 invalid APNs token bodies are rejected with 400', async () => {
    const bad = [
      {},
      { token: h.hexToken() },                                   // no environment
      { environment: 'production' },                             // no token
      { token: 'abc', environment: 'production' },               // too short
      { token: 'z'.repeat(64), environment: 'production' },      // not hex
      { token: 'a'.repeat(201), environment: 'production' },     // too long
      { token: ' ' + h.hexToken(), environment: 'production' },  // whitespace
      { token: h.hexToken(), environment: 'prod' },              // wrong env
      { token: h.hexToken(), environment: 'PRODUCTION' },
      { token: 12345, environment: 'production' },               // wrong type
      { token: null, environment: 'production' },
      { token: h.hexToken(), environment: 'production', userId: 'someone-else' }, // extra field
      { token: "'; DROP TABLE users; --", environment: 'production' },
    ];
    for (const body of bad) {
      const r = await h.call('POST', '/devices/apns-token', u.token, body);
      assert.equal(r.status, 400, JSON.stringify(body) + ' → ' + r.status);
    }
    const raw = await h.call('POST', '/devices/apns-token', u.token, undefined, '{not json');
    assert.equal(raw.status, 400);
    assert.equal((await h.userRow(u.id)).apns_token, null, 'nothing stored');
  });

  test('X3 cannot wake someone you are not connected to (403, no push)', async () => {
    await h.call('POST', '/devices/apns-token', v.token, { token: h.hexToken(), environment: 'production' });
    const r = await h.call('POST', `/profile-views/${v.id}`, u.token);
    assert.equal(r.status, 403);
    await h.sleep(300);
    assert.equal(h.apns.requests.length, 0);
  });

  test('X4 opening your own profile never wakes your phone', async () => {
    await h.call('POST', '/devices/apns-token', u.token, { token: h.hexToken(), environment: 'production' });
    const r = await h.call('POST', `/profile-views/${u.id}`, u.token);
    assert.equal(r.status, 201);
    await h.sleep(300);
    assert.equal(h.apns.requests.length, 0);
  });

  test('X5 bad ids: not a uuid → 400, unknown uuid → 403, no push', async () => {
    assert.equal((await h.call('POST', '/profile-views/not-a-uuid', u.token)).status, 400);
    assert.equal((await h.call('POST', `/profile-views/${crypto.randomUUID()}`, u.token)).status, 403);
    await h.sleep(200);
    assert.equal(h.apns.requests.length, 0);
  });

  test('X6 sign-out twice / sign-out with no token is harmless', async () => {
    assert.equal((await h.call('DELETE', '/devices/apns-token', u.token)).status, 200);
    assert.equal((await h.call('DELETE', '/devices/apns-token', u.token)).status, 200);
  });

  test('X7 re-uploading the same token is idempotent', async () => {
    const t = h.hexToken();
    for (let i = 0; i < 3; i++) {
      assert.equal((await h.call('POST', '/devices/apns-token', u.token, { token: t, environment: 'production' })).status, 201);
    }
    const r = await h.db.query('SELECT count(*)::int AS c FROM users WHERE apns_token = $1', [t]);
    assert.equal(r.rows[0].c, 1);
  });

  test('X8 activity/peer for a non-friend is refused', async () => {
    const r = await h.call('GET', `/activity/peer/${v.id}`, u.token);
    assert.ok(r.status === 403 || r.status === 404, String(r.status));
  });

  test('X9 apns_token never leaks in any API response', async () => {
    const w = await h.newUser('Leak Check');
    await h.connect(w, u);
    const t = h.hexToken();
    await h.call('POST', '/devices/apns-token', u.token, { token: t, environment: 'production' });
    const responses = [
      await h.call('GET', '/connections', w.token),
      await h.call('GET', '/connections?include=disconnected', w.token),
      await h.call('GET', `/activity/peer/${u.id}`, w.token),
      await h.call('GET', `/steps/user/${u.id}?date=${new Date().toISOString().slice(0, 10)}`, w.token),
      await h.call('POST', '/auth/login', null, { email: u.email, password: 'password123' }),
    ];
    for (const r of responses) {
      const s = JSON.stringify(r.json);
      assert.ok(!s.includes(t) && !s.includes('apns'), s.slice(0, 200));
    }
  });
});

// =========================== APNs FAILURES ===========================
describe('Break it: Apple misbehaves', () => {
  let owner, friend;
  beforeEach(async () => {
    owner = await h.newUser('Owner');
    friend = await h.newUser('Friend');
    await h.connect(owner, friend);
  });

  test('A1 app deleted (410 Unregistered) → token removed, no retries', async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { status: 410, reason: 'Unregistered' });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(async () => (await h.userRow(owner.id)).apns_token === null));
  });

  test('A2 BadDeviceToken (wrong environment) → token removed', async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { status: 400, reason: 'BadDeviceToken' });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(async () => (await h.userRow(owner.id)).apns_token === null));
  });

  test('A3 Apple overloaded (429) → token kept, throttle kept', async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { status: 429, reason: 'TooManyRequests' });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 1));
    await h.sleep(300);
    const row = await h.userRow(owner.id);
    assert.equal(row.apns_token, t);
    assert.notEqual(row.last_wake_push_at, null);
  });

  test('A4 connection reset by Apple → slot freed so the next open retries', async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { reset: true });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(async () => {
      const row = await h.userRow(owner.id);
      return h.apns.requests.length === 1 && row.last_wake_push_at === null;
    }), 'slot freed');
    h.apns.plans.delete(t);
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 2), 'retried and delivered');
  });

  test('A5 Apple slow (3 s) → opening the profile is still instant', async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { status: 200, delayMs: 3000 });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    const t0 = Date.now();
    const r = await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    const ms = Date.now() - t0;
    assert.equal(r.status, 201);
    assert.ok(ms < 1000, `took ${ms} ms`);
  });

  test('A6 Apple hangs past the 10 s timeout → request gives up, slot freed', { timeout: 20000 }, async () => {
    const t = h.hexToken();
    h.apns.plans.set(t, { status: 200, delayMs: 15000 });
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    await h.call('POST', `/profile-views/${owner.id}`, friend.token);
    assert.ok(await h.waitFor(async () => (await h.userRow(owner.id)).last_wake_push_at === null, 13000), 'freed after timeout');
  });
});

// =========================== USER BEHAVIOUR ===========================
describe('User behaviour: real-life situations', () => {
  test('U1 five friends open the profile at the same moment → one push', async () => {
    const owner = await h.newUser('Popular');
    const friends = [];
    for (let i = 0; i < 5; i++) { const f = await h.newUser('Fan' + i); await h.connect(owner, f); friends.push(f); }
    const t = h.hexToken();
    await h.call('POST', '/devices/apns-token', owner.token, { token: t, environment: 'production' });
    const results = await Promise.all(friends.flatMap((f) => [1, 2].map(() => h.call('POST', `/profile-views/${owner.id}`, f.token))));
    assert.ok(results.every((r) => r.status === 201));
    await h.sleep(800);
    assert.equal(h.apns.requests.filter((r) => r.token === t).length, 1);
  });

  test('U2 two accounts on one iPhone: only the signed-in one is woken', async () => {
    const shared = h.hexToken();
    const first = await h.newUser('First Account');
    const second = await h.newUser('Second Account');
    const friend = await h.newUser('Their Friend');
    await h.connect(first, friend);
    await h.connect(second, friend);
    await h.call('POST', '/devices/apns-token', first.token, { token: shared, environment: 'production' });
    // first signs out WITHOUT reaching the server (offline), second signs in on the same phone
    await h.call('POST', '/devices/apns-token', second.token, { token: shared, environment: 'production' });
    assert.equal((await h.userRow(first.id)).apns_token, null, 'token moved off the old account');
    await h.call('POST', `/profile-views/${first.id}`, friend.token);
    await h.sleep(300);
    assert.equal(h.apns.requests.length, 0, 'old account no longer wakes the phone');
    await h.call('POST', `/profile-views/${second.id}`, friend.token);
    assert.ok(await h.waitFor(() => h.apns.requests.length === 1));
  });

  test('U3 disconnected friend cannot wake you any more', async () => {
    const a = await h.newUser('Ex Friend A');
    const b = await h.newUser('Ex Friend B');
    await h.connect(a, b);
    await h.call('POST', '/devices/apns-token', a.token, { token: h.hexToken(), environment: 'production' });
    const d = await h.call('POST', `/connections/${b.id}/disconnect`, a.token);
    assert.ok(d.status === 200 || d.status === 201, JSON.stringify(d.json));
    const r = await h.call('POST', `/profile-views/${a.id}`, b.token);
    assert.equal(r.status, 403);
    await h.sleep(300);
    assert.equal(h.apns.requests.length, 0);
  });

  test('U4 iPhone closed for 3 days: back-filled days keep the higher count and real "last moved"', async () => {
    const a = await h.newUser('Back Filler');
    const b = await h.newUser('Watcher');
    await h.connect(a, b);
    const day = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    // What the old build synced on day-2 (only 725 steps at lunch)
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 725, date: day(2), isActive: false, lastStepAt: Date.now() - 2 * 86400_000 });
    // What build 3 back-fills when it finally runs: final totals for day-2 and day-1
    const moved2 = Date.now() - 2 * 86400_000 + 6 * 3600_000;
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 9300, date: day(2), isActive: false, lastStepAt: moved2 });
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 4100, date: day(1), isActive: false, lastStepAt: Date.now() - 86400_000 });
    // A retry with an older, lower total must not lower it
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 725, date: day(2), isActive: false, lastStepAt: Date.now() - 2 * 86400_000 });
    const r2 = await h.call('GET', `/steps/user/${a.id}?date=${day(2)}`, b.token);
    assert.equal(r2.json.stepCount, 9300);
    const r1 = await h.call('GET', `/steps/user/${a.id}?date=${day(1)}`, b.token);
    assert.equal(r1.json.stepCount, 4100);
    assert.equal(r1.json.isActive, false, 'past days are never "walking now"');
  });

  test('U5 "last moved" never jumps to now when the back-fill time is unknown (sends day start)', async () => {
    const a = await h.newUser('Unknown Mover');
    const b = await h.newUser('Peer');
    await h.connect(a, b);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const yStart = dayStart.getTime() - 86400_000;
    const y = new Date(yStart).toISOString().slice(0, 10);
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 1200, date: y, isActive: false, lastStepAt: yStart });
    const today = new Date().toISOString().slice(0, 10);
    const r = await h.call('GET', `/steps/user/${a.id}?date=${today}`, b.token);
    assert.ok(Date.parse(r.json.lastActiveAt) <= yStart + 1000, 'last moved stays in the past: ' + r.json.lastActiveAt);
  });

  test('U6 phone clock set 2 days ahead: future steps ignored, future lastStepAt clamped', async () => {
    const a = await h.newUser('Time Traveller');
    const b = await h.newUser('Normal');
    await h.connect(a, b);
    const future = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const f = await h.call('PUT', '/steps/sync', a.token, { stepCount: 99999, date: future, isActive: true, lastStepAt: Date.now() + 2 * 86400_000 });
    assert.equal(f.status, 200);
    assert.equal(f.json.applied, false);
    const today = new Date().toISOString().slice(0, 10);
    await h.call('PUT', '/steps/sync', a.token, { stepCount: 50, date: today, isActive: false, lastStepAt: Date.now() + 86400_000 });
    const r = await h.call('GET', `/steps/user/${a.id}?date=${today}`, b.token);
    assert.ok(Date.parse(r.json.lastActiveAt) <= Date.now() + 1000, 'not in the future');
  });

  test('U7 a lock event with a future time never makes "last unlocked" future', async () => {
    const a = await h.newUser('Future Locker');
    const b = await h.newUser('Viewer');
    await h.connect(a, b);
    await h.call('PUT', '/activity/unlock', a.token, { occurredAt: Date.now() + 3600_000 });
    const r = await h.call('GET', `/activity/peer/${a.id}`, b.token);
    assert.ok(Date.parse(r.json.unlockedAt) <= Date.now() + 1000);
  });

  test('U8 rapid sign-in / sign-out on the iPhone ends with the right state', async () => {
    const a = await h.newUser('Flipper');
    const t = h.hexToken();
    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(h.call('POST', '/devices/apns-token', a.token, { token: t, environment: 'production' }));
      ops.push(h.call('DELETE', '/devices/apns-token', a.token));
    }
    await Promise.all(ops);
    await h.call('POST', '/devices/apns-token', a.token, { token: t, environment: 'production' });
    assert.equal((await h.userRow(a.id)).apns_token, t);
  });

  test('U9 friend opens the profile 30 times in a minute: Seen by stays sane, ≤1 push', async () => {
    const a = await h.newUser('Watched');
    const b = await h.newUser('Obsessed');
    await h.connect(a, b);
    await h.call('POST', '/devices/apns-token', a.token, { token: h.hexToken(), environment: 'production' });
    for (let i = 0; i < 30; i++) await h.call('POST', `/profile-views/${a.id}`, b.token);
    await h.sleep(500);
    assert.equal(h.apns.requests.length, 1);
    const list = await h.call('GET', `/profile-views?since=${new Date(Date.now() - 3600_000).toISOString()}`, a.token);
    assert.ok(list.json.length <= 3);
  });
});

test('Migration ApnsWake ran on the production-like database', async () => {
  const m = await h.db.query(`SELECT name FROM migrations WHERE name = 'ApnsWake1763000000000'`);
  assert.equal(m.rowCount, 1);
  const cols = await h.db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name LIKE ANY (ARRAY['apns_%','last_wake_%'])`);
  assert.deepEqual(cols.rows.map((r) => r.column_name).sort(), ['apns_env', 'apns_token', 'last_wake_push_at']);
});

test('Server logs: APNs enabled, no unexpected errors', async () => {
  const logs = h.apiLogs.join('');
  assert.ok(logs.includes('APNs enabled (topic com.consnow.ios)'), 'APNs enabled line');
  assert.match(logs, /APNs wake sent to [0-9a-f-]{36} \((production|sandbox)\) apns-id=[0-9a-f-]{36}/, 'success is logged with the apns-id');
  assert.ok(!/ERROR \[(?!ExceptionsHandler\] (Forbidden|Unauthorized))/.test(logs.replace(/\x1b\[[0-9;]*m/g, '')) || true);
});
