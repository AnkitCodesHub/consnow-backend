import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ProfileView } from '../entities/profile-view.entity';
import { ConnectionsService } from '../connections/connections.service';

export const REPEAT_WINDOW_MS = 5 * 60_000; // same friend re-opening within 5 min is one view
export const RETENTION_MS = 48 * 3600_000; // rows older than this are deleted
export const MAX_LISTED = 5;
const PURGE_EVERY_MS = 3600_000;
const DEFAULT_WINDOW_MS = 24 * 3600_000;

@Injectable()
export class ProfileViewsService {
  private lastPurgeAt = 0;

  constructor(
    @InjectRepository(ProfileView)
    private readonly views: Repository<ProfileView>,
    private readonly connections: ConnectionsService,
  ) {}

  async recordView(viewerId: string, ownerId: string) {
    if (viewerId === ownerId) return { recorded: false, reason: 'self' };

    if (!(await this.connections.hasActiveConnection(viewerId, ownerId))) {
      throw new ForbiddenException('You are not connected to this user');
    }

    const now = Date.now();
    const last = await this.views.findOne({
      where: { viewerId, ownerId },
      order: { viewedAt: 'DESC' },
    });
    if (last && now - new Date(last.viewedAt).getTime() < REPEAT_WINDOW_MS) {
      return { recorded: false, reason: 'recent' };
    }

    await this.views.save(this.views.create({ viewerId, ownerId }));
    await this.purgeIfDue(now);
    return { recorded: true };
  }

  /** The owner's most recent distinct viewers (max 5), newest first. */
  async listViewers(ownerId: string, sinceIso?: string) {
    const since = this.resolveSince(sinceIso, Date.now());
    const rows: any[] = await this.views.query(
      `SELECT v.viewer_id AS "viewerId", u.name AS "name",
              MAX(v.viewed_at) AS "viewedAt", COUNT(*)::int AS "count"
         FROM profile_views v
         JOIN users u ON u.id = v.viewer_id
        WHERE v.owner_id = $1 AND v.viewed_at >= $2
          AND EXISTS (
            SELECT 1 FROM connections c
             WHERE c.status = 'active'
               AND ((c.user_a_id = v.viewer_id AND c.user_b_id = v.owner_id)
                 OR (c.user_a_id = v.owner_id AND c.user_b_id = v.viewer_id)))
        GROUP BY v.viewer_id, u.name
        ORDER BY MAX(v.viewed_at) DESC
        LIMIT 5`,
      [ownerId, since],
    );
    return rows.slice(0, MAX_LISTED).map((r) => ({
      viewerId: r.viewerId,
      name: r.name,
      viewedAt: new Date(r.viewedAt).toISOString(),
      count: Number(r.count),
    }));
  }

  private resolveSince(sinceIso: string | undefined, now: number): Date {
    let t = sinceIso ? Date.parse(sinceIso) : NaN;
    if (Number.isNaN(t)) t = now - DEFAULT_WINDOW_MS;
    t = Math.min(Math.max(t, now - RETENTION_MS), now);
    return new Date(t);
  }

  private async purgeIfDue(now: number) {
    if (now - this.lastPurgeAt < PURGE_EVERY_MS) return;
    this.lastPurgeAt = now;
    await this.views.delete({ viewedAt: LessThan(new Date(now - RETENTION_MS)) });
  }
}
