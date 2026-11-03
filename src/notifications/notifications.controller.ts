import { Body, Controller, Put, Request, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PushService } from './push.service';

export class FcmTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  token: string | null;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly push: PushService) {}

  /** PUT /notifications/token { token } — the app sends its FCM token after sign-in. null on sign-out. */
  @Put('token')
  saveToken(@Request() req: any, @Body() dto: FcmTokenDto) {
    return this.push.saveToken(req.user.id, dto.token ?? null);
  }
}
