import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LastUnlock } from '../entities/last-unlock.entity';
import { Connection, ConnectionStatus } from '../entities/connection.entity';
import { User } from '../entities/user.entity';
/**
 * ActivityService — handles all lock/unlock state and online presence logic.
 *
 * How online detection works:
 *   - Android sends a heartbeat ping every 60s while the phone is unlocked
 *   - We store the last heartbeat time in lastHeartbeatAt
 *   - If no heartbeat for 90s, we consider the user offline
 *   - Peer sees "offline" instead of "unlocked" when heartbeat goes stale
 */
@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(LastUnlock)
    private readonly lastUnlockRepo: Repository<LastUnlock>,
    @InjectRepository(Connection)
    private readonly connectionRepo: Repository<Connection>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Called when user unlocks their phone.
   * Upserts the unlock record — creates it if first time, updates if exists.
   * Accepts occurredAt from Android so the timestamp is accurate even if
   * the request was queued offline and sent later.
   */
  private async applyTransition(userId: string, isLocked: boolean, occurredAt?: number) {
  const now = Date.now();
  const at = new Date(occurredAt ? Math.min(occurredAt, now) : now);
  const rows = await this.lastUnlockRepo.query(
    `INSERT INTO last_unlock ("userId", "unlockedAt", "isLocked")
     VALUES ($1, $2, $3)
     ON CONFLICT ("userId") DO UPDATE
       SET "unlockedAt" = EXCLUDED."unlockedAt", "isLocked" = EXCLUDED."isLocked"
              WHERE last_unlock."unlockedAt" <= EXCLUDED."unlockedAt"
          OR last_unlock."unlockedAt" > NOW()
     RETURNING "userId"`,
    [userId, at, isLocked],
  );
  return { at, applied: rows.length > 0 };
}

async recordUnlock(userId: string, occurredAt?: number) {
  return this.applyTransition(userId, false, occurredAt);
}

async recordLock(userId: string, occurredAt?: number) {
  return this.applyTransition(userId, true, occurredAt);
}

  /**
   * Called every 60s by Android while the phone is unlocked.
   * Keeps lastHeartbeatAt fresh so peers know the user is still online.
   * If this stops updating, getPeerActivity will return isOnline: false after 90s.
   */
  async recordHeartbeat(userId: string): Promise<void> {
    await this.lastUnlockRepo.update({ userId }, { lastHeartbeatAt: new Date() });
  }

  /**
   * Returns a peer's lock status and whether they are currently online.
   *
   * isOnline logic:
   *   - true  → lastHeartbeatAt exists and is less than 90s old
   *   - false → no heartbeat ever, OR last heartbeat was more than 90s ago
   *
   * This means if a user goes offline while unlocked, their peer will see
   * them as offline after 90s instead of stuck as "unlocked" forever.
   */
  async getPeerActivity(userId: string): Promise<{ unlockedAt: Date | null; isLocked: boolean; isOnline: boolean }> {
    const record = await this.lastUnlockRepo.findOne({ where: { userId } });

    // No record at all — user has never unlocked, treat as locked + offline
    if (!record) return { unlockedAt: null, isLocked: true, isOnline: false };

    const STALE_MS = 180_000; // 3 minutes (heartbeat every 60s, allows for Android delaying it while the screen is off)
    const heartbeatStale =
      !record.lastHeartbeatAt ||
      Date.now() - record.lastHeartbeatAt.getTime() > STALE_MS;

    return {
      unlockedAt: record.unlockedAt ?? null,
      isLocked: record.isLocked,
      isOnline: !heartbeatStale,
    };
  }

  /**
   * Same as getPeerActivity but for the calling user themselves.
   * Used by GET /activity/me on HomeScreen.
   */
  async getMyActivity(userId: string): Promise<{ unlockedAt: Date | null; isLocked: boolean; isOnline: boolean }> {
    return this.getPeerActivity(userId);
  }

  /**
   * Returns all userIds that are actively connected to the given user.
   * Used to find who to notify via WebSocket on lock/unlock events.
   */
  async getPeerIds(userId: string): Promise<string[]> {
    const connections = await this.connectionRepo.find({
      where: [
        { userAId: userId, status: ConnectionStatus.ACTIVE },
        { userBId: userId, status: ConnectionStatus.ACTIVE },
      ],
    });
    return connections.map(c => (c.userAId === userId ? c.userBId : c.userAId));
  }
  async userExists(userId: string): Promise<boolean> {
    return (await this.userRepo.count({ where: { id: userId } })) > 0;
  }

  /** Peers allowed to receive live updates: active connections, only while sharing is on. */
  async getStepBroadcastTargets(userId: string): Promise<string[]> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.sharingEnabled) return [];
    return this.getPeerIds(userId);
  }
}