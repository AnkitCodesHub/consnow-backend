import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProfileViewsService } from './profile-views.service';

@Controller('profile-views')
@UseGuards(JwtAuthGuard)
export class ProfileViewsController {
  constructor(private readonly service: ProfileViewsService) {}

  /** Called when the signed-in user opens a friend's profile screen. */
  @Post(':ownerId')
  record(@Request() req: any, @Param('ownerId', new ParseUUIDPipe()) ownerId: string) {
    return this.service.recordView(req.user.id, ownerId);
  }

  /** Who opened MY profile recently (max 3). `since` = ISO start of the user's local day. */
  @Get()
  list(@Request() req: any, @Query('since') since?: string) {
    return this.service.listViewers(req.user.id, since);
  }
}
