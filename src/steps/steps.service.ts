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

 // If no sync received in 5 minutes, force inactive
const isStale = record?.updatedAt && 
    (Date.now() - new Date(record.updatedAt).getTime() > 2 * 60 * 1000);

return {
    userId: targetUserId,
    userName: targetUser.name,
    date,
    stepCount: record?.stepCount ?? 0,
    updatedAt: record?.updatedAt ?? null,
    isActive: isStale ? false : (record?.isActive ?? false),
    lastActiveAt: record?.lastActiveAt ?? null,
};
  }
}