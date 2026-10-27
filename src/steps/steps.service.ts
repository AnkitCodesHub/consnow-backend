import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailySteps } from '../entities/daily-steps.entity';
import { User } from '../entities/user.entity';
import { ConnectionsService } from '../connections/connections.service';
import { SyncStepsDto } from './dto/sync-steps.dto';
import {Not, IsNull } from 'typeorm';

// Steps older than this can't mark the user as currently walking.
const SYNC_ACTIVE_WINDOW_MS = 90_000;

@Injectable()
export class StepsService {
  constructor(
    @InjectRepository(DailySteps)
    private readonly stepsRepository: Repository<DailySteps>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    private readonly connectionsService: ConnectionsService,
  ) {}
// saves and updates current user's steps
  /**
   * PUT /steps/sync — one atomic upsert (same rule as the realtime path):
   *  - count never goes down: a late/out-of-order request with a lower count is a no-op
   *  - lastActiveAt = when the steps were taken on the device (lastStepAt), not when the
   *    request arrived, so an offline backlog doesn't make the user look active "just now"
   *  - isActive is only accepted if those steps are recent
   */
  async syncSteps(userId: string, dto: SyncStepsDto) {
    const now = Date.now();
    const stepAtMs = dto.lastStepAt != null ? Math.min(dto.lastStepAt, now) : now;
    const isActive = (dto.isActive ?? false) && now - stepAtMs < SYNC_ACTIVE_WINDOW_MS;

    const rows = await this.stepsRepository.query(
      `INSERT INTO daily_steps (user_id, date, step_count, is_active, last_active_at, updated_at)
       VALUES ($1, $2, $3, $4::boolean,
               CASE WHEN $3::int > 0 THEN to_timestamp($5::double precision / 1000) ELSE NULL END,
               now())
       ON CONFLICT (user_id, date) DO UPDATE
         SET step_count = EXCLUDED.step_count,
             is_active = EXCLUDED.is_active,
             last_active_at = CASE
               WHEN EXCLUDED.step_count > daily_steps.step_count
                 THEN GREATEST(daily_steps.last_active_at, EXCLUDED.last_active_at)
               ELSE daily_steps.last_active_at
             END,
             updated_at = now()
         WHERE EXCLUDED.step_count >= daily_steps.step_count
       RETURNING id, user_id AS "userId", date, step_count AS "stepCount",
                 is_active AS "isActive", last_active_at AS "lastActiveAt", updated_at AS "updatedAt"`,
      [userId, dto.date, dto.stepCount, isActive, stepAtMs],
    );
    if (rows.length > 0) return { ...rows[0], applied: true };

    // Stale (lower) count: ignored. Return the authoritative row.
    const current = await this.stepsRepository.findOne({ where: { userId, date: dto.date } });
    return { ...current, applied: false };
  }
  // edited on 21/10/2026
    /** Realtime step write: one atomic upsert, never lowers the count, equal count = no-op. */
  async applyLiveSteps(userId: string, date: string, stepCount: number):
    Promise<{ applied: boolean; stepCount: number; updatedAt: Date | null }> {
    const rows: { stepCount: number; updatedAt: Date }[] = await this.stepsRepository.query(
      `INSERT INTO daily_steps (user_id, date, step_count, is_active, last_active_at, updated_at)
       VALUES ($1, $2, $3, false, CASE WHEN $3::int > 0 THEN now() ELSE NULL END, now())
       ON CONFLICT (user_id, date) DO UPDATE
         SET step_count = EXCLUDED.step_count, last_active_at = now(), updated_at = now()
         WHERE daily_steps.step_count < EXCLUDED.step_count
       RETURNING step_count AS "stepCount", updated_at AS "updatedAt"`,
      [userId, date, stepCount],
    );
    if (rows.length > 0) {
      return { applied: true, stepCount: rows[0].stepCount, updatedAt: rows[0].updatedAt };
    }
    const current = await this.stepsRepository.findOne({ where: { userId, date } });
    return { applied: false, stepCount: current?.stepCount ?? 0, updatedAt: current?.updatedAt ?? null };
  }

  /** Realtime activity write into the existing is_active / last_active_at columns. */
  async applyLiveActivity(userId: string, date: string, isActive: boolean):
    Promise<{ isActive: boolean; lastActiveAt: Date | null; updatedAt: Date }> {
    const rows = await this.stepsRepository.query(
      `INSERT INTO daily_steps (user_id, date, step_count, is_active, last_active_at, updated_at)
       VALUES ($1, $2, 0, $3::boolean, CASE WHEN $3::boolean THEN now() ELSE NULL END, now())
       ON CONFLICT (user_id, date) DO UPDATE
         SET is_active = EXCLUDED.is_active,
             last_active_at = CASE WHEN EXCLUDED.is_active THEN now() ELSE daily_steps.last_active_at END,
             updated_at = now()
       RETURNING is_active AS "isActive", last_active_at AS "lastActiveAt", updated_at AS "updatedAt"`,
      [userId, date, isActive],
    );
    return rows[0];
  }

// gets current users steps for a particular date 
  async getMySteps(userId: string, date: string) {
    const record = await this.stepsRepository.findOne({
      where: { userId, date },
    });
     // If today has no record yet, fetch most recent record across all dates
  const lastActiveAt = record?.lastActiveAt
    ?? (await this.stepsRepository.findOne({
        where: { userId, lastActiveAt: Not(IsNull()) },
        order: { lastActiveAt: 'DESC' }
      }))?.lastActiveAt
    ?? null;

      return {
      date,
      stepCount: record?.stepCount ?? 0,
      updatedAt: record?.updatedAt ?? null,
      isActive: record?.isActive ?? false,
      lastActiveAt,
    };
  }
// get another users steps when another user is connected 
  async getPeerSteps(
    callerId: string,
    targetUserId: string,
    date: string,
  ) {
    // 1. Verify active connection
    const connected = await this.connectionsService.hasActiveConnection(
      callerId,
      targetUserId,
    );

    if (!connected) {
      throw new ForbiddenException(
        'No active connection with this user',
      );
    }

    // 2. Verify target user exists
    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    // 3. Verify step sharing is enabled
    if (!targetUser.sharingEnabled) {
      throw new ForbiddenException(
        'User has disabled step sharing',
      );
    }

    // 4. Get steps
    const record = await this.stepsRepository.findOne({
      where: { userId: targetUserId, date },
    });

 // If no sync received in 2 minutes, force inactive
const isStale = record?.updatedAt && 
    (Date.now() - new Date(record.updatedAt).getTime() > 2 * 60 * 1000);


// if no last active data then show the most recent data 
    const lastActiveAt = record?.lastActiveAt
    ?? (await this.stepsRepository.findOne({
        where: { userId: targetUserId, lastActiveAt: Not(IsNull()) },
        order: { lastActiveAt: 'DESC' }
    }))?.lastActiveAt
    ?? null;
return {
    userId: targetUserId,
    userName: targetUser.name,
    date,
    stepCount: record?.stepCount ?? 0,
    updatedAt: record?.updatedAt ?? null,
    isActive: isStale ? false : (record?.isActive ?? false),
    lastActiveAt,
};
  }
}