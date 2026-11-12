import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { LastUnlock } from '../entities/last-unlock.entity';
import { ApnsEnv, ApnsService } from './apns.service';

/** Same rule as ActivityService: a heartbeat in the last 3 min means the phone is live. */
export const ONLINE_MS = 180_000;
/**
 * At most one wake-up per iPhone per this many seconds. Apple throttles apps that get
 * too many silent pushes, and one fresh snapshot serves every friend looking at once.
 */
export const WAKE_MIN_INTERVAL_SEC = Number(process.env.APNS_WAKE_MIN_INTERVAL_SEC) || 300;

export type WakeOutcome = 'sent' | 'disabled' | 'online' | 'throttled_or_no_token' | 'failed' | 'token_removed';

/** TypeORM's postgres query() returns [rows, count] for UPDATE and rows for SELECT/INSERT. */
function rowsOf(result: any): any[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  return Array.isArray(result) ? result : [];
}

/**
 * Wakes a friend's iPhone so it sends a fresh snapshot (steps, walking, lock state).
 * iOS suspends Consnow in the background, so without this an iPhone only reports
 * when its owner opens the app.
 */
@Injectable()
export class WakeService {
  private readonly logger = new Logger(WakeService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(LastUnlock) private readonly lastUnlock: Repository<LastUnlock>,
    private readonly apns: ApnsService,
  ) {}

  /** POST /devices/apns-token: one iPhone token belongs to one account. */
  async saveApnsToken(userId: string, token: string, env: ApnsEnv) {
    const clean = token.trim().toLowerCase();
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ apnsToken: null, apnsEnv: null })
      .where('apns_token = :token AND id != :userId', { token: clean, userId })
      .execute();
    await this.users.update({ id: userId }, { apnsToken: clean, apnsEnv: env });
    return { success: true };
  }

  /** DELETE /devices/apns-token: on sign-out, stop waking this phone for this account. */
  async clearApnsToken(userId: string) {
    await this.users.update({ id: userId }, { apnsToken: null, apnsEnv: null });
    return { success: true };
  }

  /** Called when a friend opens `ownerId`'s profile. Never throws. */
  async wakeForProfileView(ownerId: string): Promise<WakeOutcome> {
    try {
      if (!this.apns.enabled) return 'disabled';

      // Phone already reporting live (app open or just woken): nothing to do.
      const presence = await this.lastUnlock.findOne({ where: { userId: ownerId } });
      if (presence?.lastHeartbeatAt && Date.now() - presence.lastHeartbeatAt.getTime() < ONLINE_MS) {
        return 'online';
      }

      // Claim the throttle slot atomically, so two friends opening at once send one push.
      const claimed = rowsOf(
        await this.users.query(
          `UPDATE users SET last_wake_push_at = now()
            WHERE id = $1 AND apns_token IS NOT NULL
              AND (last_wake_push_at IS NULL OR last_wake_push_at < now() - make_interval(secs => $2))
          RETURNING apns_token AS "token", apns_env AS "env"`,
          [ownerId, WAKE_MIN_INTERVAL_SEC],
        ),
      );
      if (!claimed.length) return 'throttled_or_no_token';

      const { token, env } = claimed[0];
      const result = await this.apns.sendBackground(token, env === 'sandbox' ? 'sandbox' : 'production', {
        type: 'status_request',
      });

      if (result.ok) {
        this.logger.log(`APNs wake sent to ${ownerId} (${env}) apns-id=${result.apnsId ?? '?'}`);
        return 'sent';
      }

      if (result.tokenInvalid) {
        // App deleted or token from the other APNs environment: forget it.
        await this.users.query(
          `UPDATE users SET apns_token = NULL, apns_env = NULL WHERE id = $1 AND apns_token = $2`,
          [ownerId, token],
        );
        this.logger.warn(`APNs token removed for ${ownerId}: ${result.status} ${result.reason}`);
        return 'token_removed';
      }

      if (result.status === 0) {
        // Network trouble on our side: free the slot so the next profile open retries.
        await this.users.query(`UPDATE users SET last_wake_push_at = NULL WHERE id = $1`, [ownerId]);
      }
      this.logger.warn(`APNs wake for ${ownerId} failed: ${result.status} ${result.reason} apns-id=${result.apnsId ?? '?'}`);
      return 'failed';
    } catch (e: any) {
      this.logger.warn(`wake for ${ownerId} errored: ${e?.message}`);
      return 'failed';
    }
  }
}
