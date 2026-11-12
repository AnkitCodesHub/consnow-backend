import { Body, Controller, Delete, Post, Request, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApnsEnv } from './apns.service';
import { WakeService } from './wake.service';

export class ApnsTokenDto {
  /** APNs device token as hex (64 chars today; Apple says it may grow). */
  @IsString()
  @Matches(/^[0-9a-fA-F]{64,200}$/)
  token: string;

  @IsIn(['sandbox', 'production'])
  environment: ApnsEnv;
}

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly wake: WakeService) {}

  /** The iOS app sends its APNs token after sign-in and on every launch. */
  @Post('apns-token')
  saveApnsToken(@Request() req: any, @Body() dto: ApnsTokenDto) {
    return this.wake.saveApnsToken(req.user.id, dto.token, dto.environment);
  }

  /** The iOS app calls this when signing out. */
  @Delete('apns-token')
  clearApnsToken(@Request() req: any) {
    return this.wake.clearApnsToken(req.user.id);
  }
}
