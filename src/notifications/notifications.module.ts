import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';

@Module({
  imports: [TypeOrmModule.forFeature([User]), ConnectionsModule],
  controllers: [NotificationsController],
  providers: [PushService],
})
export class NotificationsModule {}
