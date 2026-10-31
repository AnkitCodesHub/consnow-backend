import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { StepsService, isFutureDate } from './steps.service';

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
