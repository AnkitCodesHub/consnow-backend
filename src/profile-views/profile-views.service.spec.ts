import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ProfileViewsService, REPEAT_WINDOW_MS, RETENTION_MS, MAX_LISTED } from './profile-views.service';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');

function make(opts: { connected?: boolean; last?: Date | null; rows?: any[] } = {}) {
  const saved: any[] = [];
  const deletes: any[] = [];
  const queries: { sql: string; params: any[] }[] = [];
  const repo: any = {
    findOne: async () => (opts.last ? { viewedAt: opts.last } : null),
    create: (x: any) => x,
    save: async (x: any) => { saved.push(x); return x; },
    delete: async (c: any) => { deletes.push(c); },
    query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return opts.rows ?? []; },
  };
  const connections: any = { hasActiveConnection: async () => opts.connected ?? true };
  const service = new ProfileViewsService(repo, connections);
  return { service, saved, deletes, queries };
}

let realNow: () => number;
beforeEach(() => { realNow = Date.now; Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

describe('recordView', () => {
  test('a friend opening your profile is saved', async () => {
    const { service, saved } = make();
    const r = await service.recordView('viewer', 'owner');
    assert.equal(r.recorded, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].viewerId, 'viewer');
    assert.equal(saved[0].ownerId, 'owner');
  });

  test('opening your own profile is never saved', async () => {
    const { service, saved } = make();
    const r = await service.recordView('me', 'me');
    assert.deepEqual(r, { recorded: false, reason: 'self' });
    assert.equal(saved.length, 0);
  });

  test('someone who is not an active connection is rejected', async () => {
    const { service, saved } = make({ connected: false });
    await assert.rejects(() => service.recordView('stranger', 'owner'), ForbiddenException);
    assert.equal(saved.length, 0);
  });

  test('a second open within 1 minute is not counted', async () => {
    const { service, saved } = make({ last: new Date(NOW - 50_000) });
    const r = await service.recordView('viewer', 'owner');
    assert.deepEqual(r, { recorded: false, reason: 'recent' });
    assert.equal(saved.length, 0);
  });

  test('an open after more than 1 minute is counted again', async () => {
    const { service, saved } = make({ last: new Date(NOW - REPEAT_WINDOW_MS - 1_000) });
    const r = await service.recordView('viewer', 'owner');
    assert.equal(r.recorded, true);
    assert.equal(saved.length, 1);
  });

  test('old rows (over 48h) are deleted, but not on every call', async () => {
    const { service, deletes } = make();
    await service.recordView('viewer', 'owner');
    await service.recordView('viewer2', 'owner');
    assert.equal(deletes.length, 1, 'purge runs at most once per hour');
    const cutoff: Date = (deletes[0].viewedAt as any).value;
    assert.equal(cutoff.getTime(), NOW - RETENTION_MS);
  });
});

describe('listViewers', () => {
  const row = (name: string, minsAgo: number) => ({
    viewerId: name, name, viewedAt: new Date(NOW - minsAgo * 60_000),
  });

  test('returns one entry per open: the same friend can appear twice', async () => {
    const { service } = make({ rows: [row('Ankit', 1), row('Ravi', 2), row('Ankit', 3)] });
    const out = await service.listViewers('owner');
    assert.deepEqual(out.map((o) => o.name), ['Ankit', 'Ravi', 'Ankit']);
    assert.equal(out[0].viewedAt, new Date(NOW - 1 * 60_000).toISOString());
  });

  test('the query lists individual opens (no grouping)', async () => {
    const { service, queries } = make();
    await service.listViewers('owner');
    assert.doesNotMatch(queries[0].sql, /GROUP BY/);
  });

  test('never returns more than 5, and asks the database for at most 5', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row('F' + i, i + 1));
    const { service, queries } = make({ rows });
    const out = await service.listViewers('owner');
    assert.equal(out.length, MAX_LISTED);
    assert.match(queries[0].sql, /LIMIT 5/);
  });

  test('only viewers who are still active connections are listed', async () => {
    const { service, queries } = make();
    await service.listViewers('owner');
    assert.match(queries[0].sql, /c\.status = 'active'/);
  });

  test('"since" is used when valid', async () => {
    const since = new Date(NOW - 3 * 3600_000).toISOString();
    const { service, queries } = make();
    await service.listViewers('owner', since);
    assert.equal((queries[0].params[1] as Date).toISOString(), since);
  });

  test('"since" older than 48h is pulled forward to 48h', async () => {
    const { service, queries } = make();
    await service.listViewers('owner', new Date(NOW - 10 * 86400_000).toISOString());
    assert.equal((queries[0].params[1] as Date).getTime(), NOW - RETENTION_MS);
  });

  test('missing or garbage "since" falls back to the last 24h', async () => {
    const a = make(); await a.service.listViewers('owner');
    const b = make(); await b.service.listViewers('owner', 'not-a-date');
    assert.equal((a.queries[0].params[1] as Date).getTime(), NOW - 86400_000);
    assert.equal((b.queries[0].params[1] as Date).getTime(), NOW - 86400_000);
  });

  test('a "since" in the future is treated as now', async () => {
    const { service, queries } = make();
    await service.listViewers('owner', new Date(NOW + 3600_000).toISOString());
    assert.equal((queries[0].params[1] as Date).getTime(), NOW);
  });
});
