// End-to-end tests for iPhone wake-ups (APNs), Seen by and step back-fill.
// Real Postgres (embedded, production-like schema), a fake APNs HTTP/2 server, and the
// real backend (dist/main.js) in its own process; tests call it over HTTP like the apps.
// Shared harness: real Postgres (embedded), a fake APNs HTTP/2 server, and the real
// backend (dist/main.js) in its own process. Tests talk to it over HTTP like the apps do.
const path = require('path');
const http2 = require('http2');
const crypto = require('crypto');
const { spawn } = require('child_process');
// Run from the backend repo: npm run build && node --test --test-concurrency=1 test/e2e/wake.e2e.test.js
// Needs embedded-postgres once: npm i --no-save embedded-postgres
const BACKEND = process.env.BACKEND_DIR || path.resolve(__dirname, '../..');
const { pathToFileURL } = require('url');
const loadEmbeddedPostgres = async () => {
  const dir = process.env.EMBEDDED_PG_DIR || path.join(BACKEND, 'node_modules');
  return (await import(pathToFileURL(path.join(dir, 'embedded-postgres/dist/index.js')).href)).default;
};
const { Client } = require(path.join(BACKEND, 'node_modules/pg'));

const PG_PORT = 54329;
const API_PORT = 3999;
const APNS_PORT = 9443;
const API = `http://127.0.0.1:${API_PORT}`;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// ---------- fake APNs ----------
const apns = {
  requests: [],
  // per-token behaviour: { status, reason, delayMs, reset }
  plans: new Map(),
  server: null,
  clear() { this.requests = []; this.plans.clear(); },
};
function startApns() {
  apns.server = http2.createServer();
  apns.server.on('stream', (stream, headers) => {
    stream.on('error', () => {}); // the "reset" plan closes streams with an error on purpose
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      const token = String(headers[':path']).split('/').pop();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      apns.requests.push({ token, headers, body: parsed, at: Date.now() });
      const plan = apns.plans.get(token) || { status: 200 };
      if (plan.reset) { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); return; }
      setTimeout(() => {
        if (stream.destroyed) return;
        stream.respond({ ':status': plan.status, 'apns-id': crypto.randomUUID() });
        stream.end(plan.reason ? JSON.stringify({ reason: plan.reason }) : '');
      }, plan.delayMs || 0);
    });
  });
  return new Promise((r) => apns.server.listen(APNS_PORT, '127.0.0.1', r));
}

// ---------- Postgres ----------
let pg;
let db;
async function startDb() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  pg = new EmbeddedPostgres({
    databaseDir: path.join(require('os').tmpdir(), 'consnow-pgdata-' + process.pid),
    user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('consnow_test');
  db = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'consnow_test' });
  await db.connect();
}

// Build the schema the way production has it: tables from the entities (as the old
// synchronize did), WITHOUT the new APNs columns, so the ApnsWake migration really runs.
async function prepareProductionLikeSchema() {
  const { DataSource } = require(path.join(BACKEND, 'node_modules/typeorm'));
  const { databaseOptions } = require(path.join(BACKEND, 'dist/database.config'));
  process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = String(PG_PORT);
  process.env.DB_USERNAME = 'postgres'; process.env.DB_PASSWORD = 'postgres'; process.env.DB_NAME = 'consnow_test';
  const ds = new DataSource({ ...databaseOptions(), synchronize: true, migrations: [] });
  await ds.initialize();
  await ds.destroy();
  await db.query('ALTER TABLE users DROP COLUMN IF EXISTS apns_token, DROP COLUMN IF EXISTS apns_env, DROP COLUMN IF EXISTS last_wake_push_at');
  // production already ran these two migrations long ago
  await db.query(`CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, "timestamp" bigint NOT NULL, name varchar NOT NULL)`);
  await db.query(`INSERT INTO migrations ("timestamp", name) VALUES (1762156800000, 'CreateProfileViews1762156800000'), (1762300800000, 'ConnectRequests1762300800000')`);
}

// ---------- backend ----------
let api;
const apiLogs = [];
function startApi(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    api = spawn('node', ['dist/main.js'], {
      cwd: BACKEND,
      env: {
        ...process.env,
        PORT: String(API_PORT),
        DB_HOST: '127.0.0.1', DB_PORT: String(PG_PORT), DB_USERNAME: 'postgres', DB_PASSWORD: 'postgres',
        DB_NAME: 'consnow_test', DB_SYNCHRONIZE: 'false', JWT_SECRET: 'test-secret',
        APNS_KEY_ID: 'TESTKEY123', APNS_TEAM_ID: 'ZKST8KHYAB',
        APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), // as pasted into Railway on one line
        APNS_HOST_OVERRIDE: `http://127.0.0.1:${APNS_PORT}`,
        APNS_WAKE_MIN_INTERVAL_SEC: '300',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d) => {
      const s = d.toString();
      apiLogs.push(s);
      if (s.includes('running on port')) resolve();
    };
    api.stdout.on('data', onData);
    api.stderr.on('data', onData);
    api.on('exit', (code) => reject(new Error('api exited ' + code + '\n' + apiLogs.join(''))));
    setTimeout(() => reject(new Error('api start timeout\n' + apiLogs.join(''))), 60000);
  });
}

async function stopAll() {
  try { api && api.kill('SIGTERM'); } catch {}
  try { db && (await db.end()); } catch {}
  try { pg && (await pg.stop()); } catch {}
  try { apns.server && apns.server.close(); } catch {}
}

// ---------- HTTP helpers ----------
async function call(method, p, token, body, rawBody) {
  const res = await fetch(API + p, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

let n = 0;
async function newUser(name) {
  n += 1;
  const email = `${name.toLowerCase().replace(/\W/g, '')}${n}-${process.pid}@test.dev`;
  const r = await call('POST', '/auth/register', null, { name, email, password: 'password123' });
  if (r.status !== 201) throw new Error('register failed ' + r.status + ' ' + JSON.stringify(r.json));
  return { id: r.json.user.id, token: r.json.token, code: r.json.user.connectionCode, email, name };
}
async function connect(a, b) {
  const r = await call('POST', '/connections', a.token, { connectionCode: b.code });
  if (r.status !== 201) throw new Error('connect failed ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json;
}
const hexToken = () => crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
}
async function userRow(id) {
  const r = await db.query('SELECT apns_token, apns_env, last_wake_push_at FROM users WHERE id = $1', [id]);
  return r.rows[0];
}
async function resetWake(id) { await db.query('UPDATE users SET last_wake_push_at = NULL WHERE id = $1', [id]); }
async function makeStale(id) {
  await db.query(`UPDATE last_unlock SET "lastHeartbeatAt" = now() - interval '10 minutes' WHERE "userId" = $1`, [id]);
}

module.exports = {
  prepareProductionLikeSchema, apns, startApns, startDb, startApi, stopAll, call, newUser, connect, hexToken, sleep, waitFor,
  userRow, resetWake, makeStale, publicKey, apiLogs, get db() { return db; },
};
