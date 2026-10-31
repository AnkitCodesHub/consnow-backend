import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { StepsService, PEER_STALE_MS, ActivityChange } from './steps.service';

const SYNC_DTO = { stepCount: 100, date: '2026-11-01', isActive: false, lastStepAt: Date.now() };

function makeService(opts: { rows?: any[]; record?: any } = {}) {
  const repo = {
    query: async () => opts.rows ?? [],
    findOne: async () => opts.record ?? null,
  };
  const users = { findOne: async () => ({ id: 'peer', name: 'Peer', sharingEnabled: true }) };
  const connections = { hasActiveConnection: async () => true };
  return new StepsService(repo as any, users as any, connections as any);
}

const row = (isActive: boolean, wasActive: boolean | null) => ({
  id: 1, userId: 'u1', date: '2026-11-01', stepCount: 100,
  isActive, wasActive, lastActiveAt: new Date('2026-11-01T10:00:00Z'), updatedAt: new Date(),
});

// ── stale window ────────────────────────────────────────────────────────────

test('stale window is 30 seconds', () => {
  assert.equal(PEER_STALE_MS, 30_000);
});

test('peer shown inactive when no sync for more than 30s', async () => {
  const svc = makeService({ record: { isActive: true, stepCount: 5, updatedAt: new Date(Date.now() - 31_000), lastActiveAt: new Date() } });
  assert.equal((await svc.getPeerSteps('me', 'peer', '2026-11-01')).isActive, false);
});

test('peer still active when last sync was 20s ago', async () => {
  const svc = makeService({ record: { isActive: true, stepCount: 5, updatedAt: new Date(Date.now() - 20_000), lastActiveAt: new Date() } });
  assert.equal((await svc.getPeerSteps('me', 'peer', '2026-11-01')).isActive, true);
});

// ── activity-change notification ────────────────────────────────────────────

function capture(svc: StepsService) {
  const events: ActivityChange[] = [];
  svc.setActivityListener((e) => { events.push(e); });
  return events;
}

test('notifies listener when walking starts (false -> true)', async () => {
  const svc = makeService({ rows: [row(true, false)] });
  const events = capture(svc);
  await svc.syncSteps('u1', { ...SYNC_DTO, isActive: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].userId, 'u1');
  assert.equal(events[0].isActive, true);
  assert.equal(events[0].lastActiveAt, '2026-11-01T10:00:00.000Z');
});

test('notifies listener when walking stops (true -> false)', async () => {
  const svc = makeService({ rows: [row(false, true)] });
  const events = capture(svc);
  await svc.syncSteps('u1', SYNC_DTO);
  assert.equal(events.length, 1);
  assert.equal(events[0].isActive, false);
});

test('no notification while state is unchanged (every-second syncs while walking)', async () => {
  const svc = makeService({ rows: [row(true, true)] });
  const events = capture(svc);
  await svc.syncSteps('u1', { ...SYNC_DTO, isActive: true });
  assert.equal(events.length, 0);
});

test('no notification when idle sync repeats (false -> false)', async () => {
  const svc = makeService({ rows: [row(false, false)] });
  const events = capture(svc);
  await svc.syncSteps('u1', SYNC_DTO);
  assert.equal(events.length, 0);
});

test('first row of the day: starting to walk notifies, plain idle does not', async () => {
  const a = makeService({ rows: [row(true, null)] });
  const ea = capture(a);
  await a.syncSteps('u1', { ...SYNC_DTO, isActive: true });
  assert.equal(ea.length, 1);

  const b = makeService({ rows: [row(false, null)] });
  const eb = capture(b);
  await b.syncSteps('u1', SYNC_DTO);
  assert.equal(eb.length, 0);
});

test('no notification when the write was ignored (stale lower count)', async () => {
  const svc = makeService({ rows: [], record: { stepCount: 500, isActive: true } });
  const events = capture(svc);
  const res: any = await svc.syncSteps('u1', { ...SYNC_DTO, isActive: false });
  assert.equal(res.applied, false);
  assert.equal(events.length, 0);
});

test('a throwing listener never breaks the sync response', async () => {
  const svc = makeService({ rows: [row(true, false)] });
  svc.setActivityListener(() => { throw new Error('socket down'); });
  const res: any = await svc.syncSteps('u1', { ...SYNC_DTO, isActive: true });
  assert.equal(res.applied, true);
});

test('response to the client does not leak the internal wasActive field', async () => {
  const svc = makeService({ rows: [row(true, false)] });
  const res: any = await svc.syncSteps('u1', { ...SYNC_DTO, isActive: true });
  assert.equal('wasActive' in res, false);
});
