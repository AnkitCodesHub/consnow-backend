import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActivityGateway } from './activity.gateway';

type Emit = { socketId: string; event: string; payload: any };

function setup(targets: string[] = []) {
  const emits: Emit[] = [];
  let listener: ((e: any) => any) | undefined;
  const stepsService = { setActivityListener: (fn: any) => { listener = fn; } };
  const activityService = { getStepBroadcastTargets: async (_id: string) => targets };
  const gw = new ActivityGateway({} as any, stepsService as any, activityService as any);
  (gw as any).server = { to: (socketId: string) => ({ emit: (event: string, payload: any) => emits.push({ socketId, event, payload }) }) };
  const connect = (userId: string, ...socketIds: string[]) =>
    (gw as any).userToSockets.set(userId, new Set(socketIds));
  return { gw, emits, connect, fire: (e: any) => listener!(e) };
}

const change = { userId: 'walker', isActive: true, lastActiveAt: '2026-11-01T10:00:00.000Z' };

test('emitActivityToPeers sends peer_activity to every socket of every connected peer', () => {
  const { gw, emits, connect } = setup();
  connect('a', 's1', 's2');
  connect('b', 's3');
  gw.emitActivityToPeers(['a', 'b', 'offline-friend'], change);
  assert.deepEqual(emits.map((e) => e.socketId).sort(), ['s1', 's2', 's3']);
  assert.ok(emits.every((e) => e.event === 'peer_activity'));
  assert.deepEqual(emits[0].payload, change);
});

test('walking change from StepsService is pushed to the allowed targets', async () => {
  const { emits, connect, fire } = setup(['a']);
  connect('a', 's1');
  connect('stranger', 's9');
  await fire(change);
  assert.deepEqual(emits.map((e) => e.socketId), ['s1']);
});

test('nothing is pushed when sharing is off / no active connections (empty target list)', async () => {
  const { emits, connect, fire } = setup([]);
  connect('a', 's1');
  await fire(change);
  assert.equal(emits.length, 0);
});
