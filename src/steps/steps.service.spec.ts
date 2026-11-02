import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { StepsService, isFutureDate, notFuture } from './steps.service';

// 30 Oct 2026, 00:20 in India = 29 Oct 18:50 UTC (the moment the bug was seen)
const NOW = Date.parse('2026-10-29T18:50:00.000Z');

function makeService() {
  const queries: { sql: string; params: any[] }[] = [];
  const stepsRepository: any = {
    query: async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      return [{ userId: params[0], date: params[1], stepCount: params[2] }];
    },
    findOne: async () => null,
  };
  const service = new StepsService(stepsRepository, {} as any, {} as any);
  return { service, queries };
}

let realNow: () => number;
beforeEach(() => { realNow = Date.now; Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

describe('isFutureDate', () => {
  test('today in India (30 Oct) is a real date', () => assert.equal(isFutureDate('2026-10-30', NOW), false));
  test('yesterday in UTC (29 Oct) is a real date', () => assert.equal(isFutureDate('2026-10-29', NOW), false));
  test('31 Oct has not started anywhere on Earth yet', () => assert.equal(isFutureDate('2026-10-31', NOW), true));
  test('a month ahead is future', () => assert.equal(isFutureDate('2026-11-29', NOW), true));
  test('an old offline backlog day is allowed', () => assert.equal(isFutureDate('2026-10-20', NOW), false));
});

describe('syncSteps with a phone clock set forward (the 30/31 Oct bug)', () => {
  test('future date: nothing is written, app still gets OK so it stops retrying', async () => {
    const { service, queries } = makeService();
    const r: any = await service.syncSteps('u1', { date: '2026-10-31', stepCount: 48, isActive: true, lastStepAt: NOW } as any);
    assert.equal(queries.length, 0, 'must not write a row for a day that has not happened');
    assert.equal(r.applied, false);
    assert.equal(r.ignored, 'future_date');
  });

  test('today: written as normal', async () => {
    const { service, queries } = makeService();
    const r: any = await service.syncSteps('u1', { date: '2026-10-30', stepCount: 20, isActive: false, lastStepAt: NOW } as any);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[1], '2026-10-30');
    assert.equal(r.applied, true);
  });

  test('future lastStepAt is clamped to server time', async () => {
    const { service, queries } = makeService();
    await service.syncSteps('u1', { date: '2026-10-30', stepCount: 20, isActive: false, lastStepAt: NOW + 86_400_000 } as any);
    assert.equal(queries[0].params[4], NOW);
  });
});

describe('realtime writers also refuse future dates', () => {
  test('applyLiveSteps', async () => {
    const { service, queries } = makeService();
    const r = await service.applyLiveSteps('u1', '2026-10-31', 48);
    assert.equal(r.applied, false);
    assert.equal(queries.length, 0);
  });
  test('applyLiveActivity', async () => {
    const { service, queries } = makeService();
    await service.applyLiveActivity('u1', '2026-10-31', true);
    assert.equal(queries.length, 0);
  });
});

describe('syncSteps: a lower count never blocks timing (reinstall bug)', () => {
  test('no WHERE guard on the upsert; count still never goes down', async () => {
    const { service, queries } = makeService();
    await service.syncSteps('u1', { date: '2026-10-30', stepCount: 3, isActive: true, lastStepAt: NOW } as any);
    const sql = queries[0].sql;
    assert.ok(!/WHERE\s+EXCLUDED\.step_count/.test(sql), 'a lower count must not skip the whole update');
    assert.match(sql, /step_count\s*=\s*GREATEST\(daily_steps\.step_count, EXCLUDED\.step_count\)/);
    assert.match(sql, /is_active\s*=\s*EXCLUDED\.is_active/);
  });

  test('a future last_active_at stored earlier is dropped', async () => {
    const { service, queries } = makeService();
    await service.syncSteps('u1', { date: '2026-10-30', stepCount: 3, isActive: false, lastStepAt: NOW } as any);
    assert.match(queries[0].sql, /daily_steps\.last_active_at > now\(\) THEN NULL/);
  });
});

describe('notFuture', () => {
  test('past time is kept', () => { const d = new Date(NOW - 1000); assert.equal(notFuture(d, NOW), d); });
  test('future time is dropped', () => assert.equal(notFuture(new Date(NOW + 60_000), NOW), null));
  test('null stays null', () => assert.equal(notFuture(null, NOW), null));
});

describe('getMySteps ignores a future "last moved"', () => {
  test('falls back to the latest real time', async () => {
    const past = new Date(NOW - 3_600_000);
    const calls: any[] = [];
    const repo: any = {
      findOne: async (opts: any) => {
        calls.push(opts);
        return calls.length === 1
          ? { stepCount: 40, lastActiveAt: new Date(NOW + 86_400_000) } // today's row, future time
          : { lastActiveAt: past };
      },
    };
    const r = await new StepsService(repo, {} as any, {} as any).getMySteps('u1', '2026-10-30');
    assert.equal(r.lastActiveAt, past);
    assert.equal(calls[1].where.lastActiveAt.type, 'lessThanOrEqual');
  });
});
