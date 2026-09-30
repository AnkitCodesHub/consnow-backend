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

@Injectable()
export class StepsService {
  constructor(
    @InjectRepository(DailySteps)
    private readonly stepsRepository: Repository<DailySteps>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly connectionsService: ConnectionsService,
  ) {}

  /**
   * Upsert today's step count for the authenticated user.
   * Idempotent: repeated calls with the same (userId, date) overwrite
   * the step_count rather than creating duplicate rows.
   * The client sends the TOTAL step count for the day, not a delta.
   */
  async syncSteps(userId: string, dto: SyncStepsDto) {
    const existing = await this.stepsRepository.findOne({
      where: { userId, date: dto.date },
    });

    if (existing) {
      // Only update if incoming count is >= existing (monotonic for a given day)
      if (dto.stepCount >= existing.stepCount) {
        existing.stepCount = dto.stepCount;
        return this.stepsRepository.save(existing);
      }
      // If client sends a lower count (e.g., stale cache), ignore silently
      return existing;
    }

    const record = this.stepsRepository.create({
      userId,
      date: dto.date,
      stepCount: dto.stepCount,
    });

    return this.stepsRepository.save(record);
  }

  /** Get own steps for today */
  async getMySteps(userId: string, date: string) {
    const record = await this.stepsRepository.findOne({
      where: { userId, date },
    });

    return {
      date,
      stepCount: record?.stepCount ?? 0,
      updatedAt: record?.updatedAt ?? null,
    };
  }

  /**
   * Get another user's steps.
   * Authorization: caller must have an active connection AND target must have sharing enabled.
   */
  async getPeerSteps(callerId: string, targetUserId: string, date: string) {
    // 1. Verify active connection
    const connected = await this.connectionsService.hasActiveConnection(
      callerId,
      targetUserId,
    );
    if (!connected) {
      throw new ForbiddenException('No active connection with this user');
    }

    // 2. Verify target has sharing enabled
    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }
    if (!targetUser.sharingEnabled) {
      throw new ForbiddenException('User has disabled step sharing');
    }

    // 3. Return steps
    const record = await this.stepsRepository.findOne({
      where: { userId: targetUserId, date },
    });

    return {
      userId: targetUserId,
      userName: targetUser.name,
      date,
      stepCount: record?.stepCount ?? 0,
      updatedAt: record?.updatedAt ?? null,
    };
  }
}
