import 'reflect-metadata';
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { FindOperator } from 'typeorm';
import {
  ConnectionsService,
  ConnectionEvent,
  DECLINE_COOLDOWN_MS,
  REQUEST_TTL_MS,
  UNDO_WINDOW_MS,
} from './connections.service';
import { ConnectionStatus } from '../entities/connection.entity';
import { ConnectionRequestStatus } from '../entities/connection-request.entity';

/** Tiny in-memory stand-in for a TypeORM repository (supports In / MoreThan). */
function fakeRepo<T extends { id?: string }>(rows: T[] = []) {
  let seq = 0;
  const matchValue = (actual: any, expected: any) => {
    if (expected instanceof FindOperator) {
      const v = (expected as any).value;
      switch ((expected as any).type) {
        case 'in': return v.includes(actual);
        case 'moreThan': return actual != null && actual > v;
        default: throw new Error('op ' + (expected as any).type);
      }
    }
    return actual === expected;
  };
  const matches = (row: any, where: any) =>
    (Array.isArray(where) ? where : [where]).some((w) =>
      Object.entries(w).every(([k, v]) => matchValue(row[k], v)),
    );
  return {
    rows,
    create: (x: any) => ({ ...x }),
    save: async (x: any) => {
      for (const item of Array.isArray(x) ? x : [x]) {
        if (!item.id) { item.id = `id${++seq}`; item.createdAt = item.createdAt ?? new Date(Date.now()); }
        if (!rows.includes(item)) rows.push(item);
      }
      return x;
    },
    find: async (opts: any = {}) => rows.filter((r) => !opts.where || matches(r, opts.where)),
    findOne: async (opts: any) => {
      const found = rows.filter((r) => matches(r, opts.where));
      if (opts.order?.respondedAt === 'DESC') found.sort((a: any, b: any) => b.respondedAt - a.respondedAt);
      return found[0] ?? null;
    },
  };
}

const T0 = Date.parse('2026-11-03T10:00:00.000Z');
let now = T0;
let realNow: () => number;
beforeEach(() => { now = T0; realNow = Date.now; Date.now = () => now; });
afterEach(() => { Date.now = realNow; });
// new Date() with no args must follow the fake clock too
const RealDate = Date;
(global as any).Date = class extends RealDate {
  constructor(...a: any[]) { super(...((a.length ? a : [Date.now()]) as [])); }
  static now() { return now; }
};

function setup(status = ConnectionStatus.ACTIVE) {
  const alice = { id: 'alice', name: 'Alice', sharingEnabled: true };
  const bob = { id: 'bob', name: 'Bob', sharingEnabled: true };
  const conn: any = { id: 'c1', userAId: 'alice', userBId: 'bob', userA: alice, userB: bob, status, createdAt: new Date(T0) };
  const connections = fakeRepo<any>([conn]);
  const users = fakeRepo<any>([alice, bob]);
  const requests = fakeRepo<any>([]);
  const svc = new ConnectionsService(connections as any, users as any, requests as any);
  const events: ConnectionEvent[] = [];
  svc.onEvent((e) => { events.push(e); });
  return { svc, conn, requests, events };
}
const flush = () => new Promise((r) => setImmediate(r));
const stateFor = async (svc: ConnectionsService, me: string) =>
  ((await svc.getConnections(me, true)) as any[])[0];

describe('disconnect', () => {
  test('is instant, hides the friend for both, and tells both phones', async () => {
    const { svc, conn, events } = setup();
    const r = await svc.disconnect('alice', 'bob');
    assert.equal(conn.status, ConnectionStatus.REVOKED);
    assert.equal(r.undoUntil, new Date(T0 + UNDO_WINDOW_MS).toISOString());
    assert.equal((await stateFor(svc, 'bob')).state, 'disconnected');
    assert.equal((await stateFor(svc, 'alice')).state, 'disconnected');
    assert.equal((await svc.getConnections('bob')).length, 0, 'old app: row hidden');
    await flush();
    assert.deepEqual(events.map((e) => [e.userId, e.type]).sort(), [['alice', 'disconnected'], ['bob', 'disconnected']]);
  });

  test('undo works within the window, only for the person who disconnected', async () => {
    const { svc, conn } = setup();
    await svc.disconnect('alice', 'bob');
    await assert.rejects(svc.undoDisconnect('bob', 'alice'));
    now += 4000;
    await svc.undoDisconnect('alice', 'bob');
    assert.equal(conn.status, ConnectionStatus.ACTIVE);
  });

  test('undo fails after the window', async () => {
    const { svc } = setup();
    await svc.disconnect('alice', 'bob');
    now += UNDO_WINDOW_MS + 1;
    await assert.rejects(svc.undoDisconnect('alice', 'bob'));
  });
});

describe('connect requests', () => {
  test('either side can request; accept reconnects both', async () => {
    const { svc, conn, events } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    assert.equal(r.state, 'request_sent');
    assert.equal((await stateFor(svc, 'alice')).state, 'request_received');
    assert.equal((await stateFor(svc, 'bob')).state, 'request_sent');
    assert.equal((await svc.listIncomingRequests('alice')).length, 1);
    await svc.acceptRequest('alice', r.requestId);
    assert.equal(conn.status, ConnectionStatus.ACTIVE);
    await flush();
    assert.ok(events.some((e) => e.userId === 'bob' && e.type === 'request_accepted' && e.peerName === 'Alice'));
  });

  test('tapping Connect twice does not create two requests', async () => {
    const { svc, requests } = setup(ConnectionStatus.REVOKED);
    const a: any = await svc.requestConnect('bob', 'alice');
    const b: any = await svc.requestConnect('bob', 'alice');
    assert.equal(a.requestId, b.requestId);
    assert.equal(requests.rows.length, 1);
  });

  test('both tap Connect -> connected immediately (mutual consent)', async () => {
    const { svc, conn } = setup(ConnectionStatus.REVOKED);
    await svc.requestConnect('bob', 'alice');
    const r = await svc.requestConnect('alice', 'bob');
    assert.equal(r.state, 'connected');
    assert.equal(conn.status, ConnectionStatus.ACTIVE);
  });

  test('request expires after 24 h', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    now += REQUEST_TTL_MS + 1;
    assert.equal((await svc.listIncomingRequests('alice')).length, 0);
    assert.equal((await stateFor(svc, 'alice')).state, 'disconnected');
    await assert.rejects(svc.acceptRequest('alice', r.requestId));
    // and a fresh request can be sent
    const again: any = await svc.requestConnect('bob', 'alice');
    assert.notEqual(again.requestId, r.requestId);
  });

  test('decline -> 3 h cooldown for the sender, then allowed again', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    await svc.declineRequest('alice', r.requestId);
    const bobView = await stateFor(svc, 'bob');
    assert.equal(bobView.state, 'cooldown');
    assert.equal(bobView.cooldownUntil, new Date(T0 + DECLINE_COOLDOWN_MS).toISOString());
    await assert.rejects(svc.requestConnect('bob', 'alice'), (e: any) => e.getStatus() === 429);
    // Alice is not blocked by Bob's cooldown
    assert.equal((await svc.requestConnect('alice', 'bob')).state, 'request_sent');
  });

  test('cooldown ends after 3 h', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    await svc.declineRequest('alice', r.requestId);
    now += DECLINE_COOLDOWN_MS + 1;
    assert.equal((await svc.requestConnect('bob', 'alice')).state, 'request_sent');
  });

  test('sender can cancel', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    await svc.cancelRequest('bob', r.requestId);
    assert.equal((await stateFor(svc, 'alice')).state, 'disconnected');
  });

  test('only the receiver can accept', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    const r: any = await svc.requestConnect('bob', 'alice');
    await assert.rejects(svc.acceptRequest('bob', r.requestId));
  });

  test('cannot request someone you were never connected to', async () => {
    const { svc } = setup(ConnectionStatus.REVOKED);
    await assert.rejects(svc.requestConnect('bob', 'stranger'));
  });
});
