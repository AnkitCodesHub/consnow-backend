import { Controller, Get, Param, Put, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActivityGateway } from './activity.gateway';
import { ActivityService } from './activity.service';

@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activityService: ActivityService,
    private readonly activityGateway: ActivityGateway,
  ) {}

  @Put('unlock')
  @UseGuards(JwtAuthGuard)
  async reportUnlock(@Request() req: { user: { id: string } }) {
    const userId: string = req.user.id;
    const unlockedAt = await this.activityService.recordUnlock(userId);
    const peerIds = await this.activityService.getPeerIds(userId);
    this.activityGateway.emitUnlockToPeers(peerIds, userId, unlockedAt);
    return { success: true, unlockedAt };
  }

  @Put('lock')
  @UseGuards(JwtAuthGuard)
  async reportLock(@Request() req: { user: { id: string } }) {
    const userId: string = req.user.id;
    await this.activityService.recordLock(userId);
    const peerIds = await this.activityService.getPeerIds(userId);
    this.activityGateway.emitLockToPeers(peerIds, userId);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMyActivity(@Request() req: { user: { id: string } }) {
    const activity = await this.activityService.getMyActivity(req.user.id);
    return {
      unlockedAt: activity.unlockedAt?.toISOString() ?? null,
      isLocked: activity.isLocked,
    };
  }

  @Get('peer/:userId')
  @UseGuards(JwtAuthGuard)
  async getPeerActivity(@Param('userId') userId: string) {
    const activity = await this.activityService.getPeerActivity(userId);
    return {
      userId,
      unlockedAt: activity.unlockedAt?.toISOString() ?? null,
      isLocked: activity.isLocked,
    };
  }
}