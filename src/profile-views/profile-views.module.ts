import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProfileView } from '../entities/profile-view.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProfileViewsController } from './profile-views.controller';
import { ProfileViewsService } from './profile-views.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProfileView]), ConnectionsModule, NotificationsModule],
  controllers: [ProfileViewsController],
  providers: [ProfileViewsService],
})
export class ProfileViewsModule {}
