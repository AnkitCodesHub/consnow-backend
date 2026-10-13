import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LastUnlock } from '../entities/last-unlock.entity';
import { Connection, ConnectionStatus } from '../entities/connection.entity';

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(LastUnlock)
    private readonly lastUnlockRepo: Repository<LastUnlock>,
    @InjectRepository(Connection)
    private readonly connectionRepo: Repository<Connection>,
  ) {}

  async recordUnlock(userId: string): Promise<Date> {
    const now = new Date();
    await this.lastUnlockRepo.upsert(
      { userId, unlockedAt: now, isLocked: false },
      ['userId'],
    );
    return now;
  }

  async recordLock(userId: string): Promise<void> {
    await this.lastUnlockRepo.upsert({ userId, isLocked: true }, ['userId']);
  }

  async getPeerActivity(userId: string): Promise<{ unlockedAt: Date | null; isLocked: boolean }> {
    const record = await this.lastUnlockRepo.findOne({ where: { userId } });
    return {
      unlockedAt: record?.unlockedAt ?? null,
      isLocked: record?.isLocked ?? true,
    };
  }

  async getMyActivity(userId: string): Promise<{ unlockedAt: Date | null; isLocked: boolean }> {
    return this.getPeerActivity(userId);
  }

  async getPeerIds(userId: string): Promise<string[]> {
    const connections = await this.connectionRepo.find({
      where: [
        { userAId: userId, status: ConnectionStatus.ACTIVE },
        { userBId: userId, status: ConnectionStatus.ACTIVE },
      ],
    });
    return connections.map(c => (c.userAId === userId ? c.userBId : c.userAId));
  }
}