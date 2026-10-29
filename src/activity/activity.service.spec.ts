import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';

const NOW = Date.parse('2026-10-29T17:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function makeService(opts: { record?: any; connectionCount?: number } = {}) {
  const queries: { sql: string; params: any[] }[] = [];
  const lastUnlockRepo: any = {
    query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return [{ userId: params[0] }]; },
    findOne: async () => opts.record ?? null,
    update: async () => ({}),
  };
  const connectionRepo: any = {
    count: async () => opts.connectionCount ?? 0,
    find: async () => [],
  };
  const userRepo: any = { count: async () => 1, findOne: async () => null };
  const service = new ActivityService(lastUnlockRepo, connectionRepo, userRepo);
  return { service, queries };
}

let realNow: () => number;
beforeEach(() => { realNow = Date.now; Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

describe('lock/unlock timestamps', () => {
  test('U1: unlock 30 days in the future is clamped to server now', async () => {
    const { service, queries } = makeService();
    const { at } = await service.recordUnlock('u1', NOW + 30 * DAY);
    assert.ok(at.getTime() <= NOW);
    assert.ok((queries[0].params[1] as Date).getTime() <= NOW);
  });

  test('U2: unlock with no occurredAt uses server now', async () => {
    const { service } = makeService();
    const { at } = await service.recordUnlock('u1');
    assert.equal(at.getTime(), NOW);
  });

  test('U3: SQL lets a real event overwrite a future-dated row (self-heal guard present)', async () => {
    const { service, queries } = makeService();
    await service.recordLock('u1', NOW);
    assert.match(queries[0].sql, /last_unlock\."unlockedAt"\s*>\s*NOW\(\)/);
  });

  test('U4: SQL ignores an event older than the stored one (ordering guard present)', async () => {
    const { service, queries } = makeService();
    await service.recordLock('u1', NOW - 1000);
    assert.match(queries[0].sql, /WHERE\s+last_unlock\."unlockedAt"\s*<=\s*EXCLUDED\."unlockedAt"/);
  });

  test('B2: occurredAt = -1 is not stored as 1969', async () => {
    const { service } = makeService();
    const { at } = await service.recordUnlock('u1', -1);
    assert.ok(at.getTime() > NOW - DAY, `stored ${at.toISOString()}`);
  });

  test('B3: occurredAt = "hello" does not produce an Invalid Date (would be a 500)', async () => {
    const { service } = makeService();
    const { at } = await service.recordUnlock('u1', 'hello' as any);
    assert.ok(!Number.isNaN(at.getTime()), 'got Invalid Date');
  });
});

describe('online detection', () => {
  test('U5: last heartbeat 179 s ago -> online', async () => {
    const { service } = makeService({ record: { unlockedAt: new Date(NOW), isLocked: true, lastHeartbeatAt: new Date(NOW - 179_000) } });
    assert.equal((await service.getPeerActivity('u1')).isOnline, true);
  });

  test('U6: last heartbeat 181 s ago -> offline', async () => {
    const { service } = makeService({ record: { unlockedAt: new Date(NOW), isLocked: false, lastHeartbeatAt: new Date(NOW - 181_000) } });
    assert.equal((await service.getPeerActivity('u1')).isOnline, false);
  });

  test('U7a: no row -> offline and locked', async () => {
    const { service } = makeService();
    const r = await service.getPeerActivity('u1');
    assert.deepEqual(r, { unlockedAt: null, isLocked: true, isOnline: false });
  });

  test('U7b: row but no heartbeat ever -> offline', async () => {
    const { service } = makeService({ record: { unlockedAt: new Date(NOW), isLocked: false, lastHeartbeatAt: null } });
    assert.equal((await service.getPeerActivity('u1')).isOnline, false);
  });
});

describe('B6: consent — peer activity only for connected friends', () => {
  const gateway: any = { emitUnlockToPeers() {}, emitLockToPeers() {} };

  test('not connected -> 403, no data', async () => {
    const { service } = makeService({ connectionCount: 0, record: { unlockedAt: new Date(NOW), isLocked: false, lastHeartbeatAt: new Date(NOW) } });
    const ctrl = new ActivityController(service, gateway);
    await assert.rejects(ctrl.getPeerActivity({ user: { id: 'me' } }, 'stranger'), ForbiddenException);
  });

  test('connected -> data returned', async () => {
    const { service } = makeService({ connectionCount: 1, record: { unlockedAt: new Date(NOW), isLocked: false, lastHeartbeatAt: new Date(NOW) } });
    const ctrl = new ActivityController(service, gateway);
    const r = await ctrl.getPeerActivity({ user: { id: 'me' } }, 'friend');
    assert.equal(r.userId, 'friend');
    assert.equal(r.isOnline, true);
  });

  test('asking for yourself through /peer is not a connection', async () => {
    const { service } = makeService({ connectionCount: 1 });
    assert.equal(await service.areConnected('me', 'me'), false);
  });
});
