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
async syncSteps(userId: string, dto: SyncStepsDto) {
    const existing = await this.stepsRepository.findOne({
      where: { userId, date: dto.date },
    });

    if (existing) { 
      if (dto.stepCount >= existing.stepCount) {
        existing.stepCount = dto.stepCount;
        existing.isActive = dto.isActive ?? false;
        if (dto.isActive) {
          existing.lastActiveAt = new Date();
        }
        return this.stepsRepository.save(existing);
      }
      return existing;
    }

    const record = this.stepsRepository.create({
      userId,
      date: dto.date,
      stepCount: dto.stepCount,
      isActive: dto.isActive ?? false,
      ...(dto.isActive ? { lastActiveAt: new Date() } : {}),
    });

    return this.stepsRepository.save(record);
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