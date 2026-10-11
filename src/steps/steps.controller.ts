import {
  Controller,
  Put,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StepsService } from './steps.service';
import { SyncStepsDto } from './dto/sync-steps.dto';

@Controller('steps')
@UseGuards(JwtAuthGuard)
export class StepsController {
  constructor(private readonly stepsService: StepsService) {}

  /** Upsert step count for authenticated user */
@Put('sync')
async syncSteps(@Request() req:any, @Body() body: SyncStepsDto) {
  return this.stepsService.syncSteps(
    req.user.id,
    body,
  );
}

  /** Get own steps for a date (defaults to today) */
  @Get('me')
  async getMySteps(
    @Request() req: any,
    @Query('date') date?: string,
  ) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.stepsService.getMySteps(req.user.id, d);
  }

  /** Get connected user's steps */
  @Get('user/:userId')
  async getPeerSteps(
    @Request() req: any,
    @Param('userId') targetUserId: string,
    @Query('date') date?: string,
  ) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.stepsService.getPeerSteps(req.user.id, targetUserId, d);
  }
  @Get('health')
health() {
    return { status: 'ok' };
}
}

