import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { LastUnlock } from '../entities/last-unlock.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { NotificationsController } from './notifications.controller';
import { DevicesController } from './devices.controller';
import { PushService } from './push.service';
import { ApnsService } from './apns.service';
import { WakeService } from './wake.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, LastUnlock]), ConnectionsModule],
  controllers: [NotificationsController, DevicesController],
  providers: [PushService, ApnsService, WakeService],
  exports: [WakeService],
})
export class NotificationsModule {}
