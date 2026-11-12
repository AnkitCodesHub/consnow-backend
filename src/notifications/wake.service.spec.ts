import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { WakeService, ONLINE_MS } from './wake.service';

function make(opts: {
  enabled?: boolean;
  heartbeatAgoMs?: number | null;
  claim?: any; // what the UPDATE ... RETURNING gives back
  send?: { ok: boolean; status: number; reason?: string; tokenInvalid: boolean };
} = {}) {
  const queries: { sql: string; params: any[] }[] = [];
  const sent: any[] = [];
  const users: any = {
    query: async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      if (sql.includes('last_wake_push_at = now()')) return opts.claim ?? [[], 0];
      return [[], 1];
    },
  };
  const lastUnlock: any = {
    findOne: async () =>
      opts.heartbeatAgoMs == null ? null : { lastHeartbeatAt: new Date(Date.now() - opts.heartbeatAgoMs) },
  };
  const apns: any = {
    enabled: opts.enabled ?? true,
    sendBackground: async (token: string, env: string, data: any) => {
      sent.push({ token, env, data });
      return opts.send ?? { ok: true, status: 200, tokenInvalid: false };
    },
  };
  return { service: new WakeService(users, lastUnlock, apns), queries, sent };
}

const TOKEN = 'a'.repeat(64);

describe('wakeForProfileView', () => {
  test('sends a silent push to an iPhone that has gone quiet', async () => {
    const { service, sent } = make({ heartbeatAgoMs: 60 * 60_000, claim: [[{ token: TOKEN, env: 'production' }], 1] });
    assert.equal(await service.wakeForProfileView('owner'), 'sent');
    assert.deepEqual(sent, [{ token: TOKEN, env: 'production', data: { type: 'status_request' } }]);
  });

  test('does nothing when APNs is not configured', async () => {
    const { service, sent, queries } = make({ enabled: false });
    assert.equal(await service.wakeForProfileView('owner'), 'disabled');
    assert.equal(sent.length, 0);
    assert.equal(queries.length, 0);
  });

  test('does not wake a phone that is already live', async () => {
    const { service, sent } = make({ heartbeatAgoMs: ONLINE_MS - 5_000, claim: [[{ token: TOKEN, env: 'production' }], 1] });
    assert.equal(await service.wakeForProfileView('owner'), 'online');
    assert.equal(sent.length, 0);
  });

  test('throttled or no iPhone token: no push', async () => {
    const { service, sent } = make({ heartbeatAgoMs: null, claim: [[], 0] });
    assert.equal(await service.wakeForProfileView('owner'), 'throttled_or_no_token');
    assert.equal(sent.length, 0);
  });

  test('a dead token is removed', async () => {
    const { service, queries } = make({
      heartbeatAgoMs: null,
      claim: [[{ token: TOKEN, env: 'sandbox' }], 1],
      send: { ok: false, status: 410, reason: 'Unregistered', tokenInvalid: true },
    });
    assert.equal(await service.wakeForProfileView('owner'), 'token_removed');
    assert.ok(queries.some((q) => q.sql.includes('apns_token = NULL') && q.params[1] === TOKEN));
  });

  test('a network failure frees the throttle slot for a retry', async () => {
    const { service, queries } = make({
      heartbeatAgoMs: null,
      claim: [[{ token: TOKEN, env: 'production' }], 1],
      send: { ok: false, status: 0, reason: 'timeout', tokenInvalid: false },
    });
    assert.equal(await service.wakeForProfileView('owner'), 'failed');
    assert.ok(queries.some((q) => q.sql.includes('last_wake_push_at = NULL')));
  });

  test('never throws, even if the database does', async () => {
    const { service } = make();
    (service as any).lastUnlock.findOne = async () => {
      throw new Error('db down');
    };
    assert.equal(await service.wakeForProfileView('owner'), 'failed');
  });
});
