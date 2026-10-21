import { Controller, Get, Param, Put, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActivityGateway } from './activity.gateway';
import { ActivityService } from './activity.service';

/**
 * ActivityController — handles all phone lock/unlock activity endpoints.
 *
 * Endpoints:
 *   PUT  /activity/unlock    — record phone unlock, notify peers via WebSocket
 *   PUT  /activity/lock      — record phone lock, notify peers via WebSocket
 *   PUT  /activity/heartbeat — keep-alive ping while phone is unlocked (every 60s)
 *   GET  /activity/me        — fetch own current lock status
 *   GET  /activity/peer/:id  — fetch a peer's lock status + online state
 */
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activityService: ActivityService,
    private readonly activityGateway: ActivityGateway,
  ) {}

  /**
   * Called when the user unlocks their phone.
   * Stores unlock timestamp in DB and emits peer_unlocked WebSocket event to all peers.
   * Body: { occurredAt: number } — epoch millis from Android (used as actual unlock time)
   */
 @Put('unlock')
  @UseGuards(JwtAuthGuard)
  async reportUnlock(@Request() req: { user: { id: string }; body: { occurredAt?: number } }) {
    const userId: string = req.user.id;
    const { at, applied } = await this.activityService.recordUnlock(userId, req.body?.occurredAt);
    if (applied) {
      const peerIds = await this.activityService.getPeerIds(userId);
      this.activityGateway.emitUnlockToPeers(peerIds, userId, at);
    }
    return { success: true, unlockedAt: at };
  }

  /**
   * Called when the user locks their phone (screen off).
   * Updates isLocked flag in DB and emits peer_locked WebSocket event to all peers.
   * Body: { occurredAt: number } — epoch millis from Android
   */
 @Put('lock')
  @UseGuards(JwtAuthGuard)
  async reportLock(@Request() req: { user: { id: string }; body: { occurredAt?: number } }) {
    const userId: string = req.user.id;
    const { at, applied } = await this.activityService.recordLock(userId, req.body?.occurredAt);
    if (applied) {
      const peerIds = await this.activityService.getPeerIds(userId);
      this.activityGateway.emitLockToPeers(peerIds, userId, at);
    }
    return { success: true };
  }

  /**
   * Heartbeat ping sent every 60s by Android while phone is unlocked.
   * Server uses lastHeartbeatAt to infer whether the user is online.
   * If no heartbeat for 90s, peer sees the user as offline instead of unlocked.
   */
  @Put('heartbeat')
  @UseGuards(JwtAuthGuard)
  async heartbeat(@Request() req: { user: { id: string } }) {
    await this.activityService.recordHeartbeat(req.user.id);
    return { success: true };
  }

  /**
   * Returns the calling user's own current lock status.
   * Used by HomeScreen to show the user's own lock state.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMyActivity(@Request() req: { user: { id: string } }) {
    const activity = await this.activityService.getMyActivity(req.user.id);
    return {
      unlockedAt: activity.unlockedAt?.toISOString() ?? null,
      isLocked: activity.isLocked,
      isOnline: activity.isOnline,
    };
  }

  /**
   * Returns a peer's lock status and online state.
   * isOnline = false if no heartbeat received in the last 90s.
   * Used by PeerStepsScreen to show lock widget.
   */
  @Get('peer/:userId')
  @UseGuards(JwtAuthGuard)
  async getPeerActivity(@Param('userId') userId: string) {
    const activity = await this.activityService.getPeerActivity(userId);
    return {
      userId,
      unlockedAt: activity.unlockedAt?.toISOString() ?? null,
      isLocked: activity.isLocked,
      isOnline: activity.isOnline,
    };
  }
}