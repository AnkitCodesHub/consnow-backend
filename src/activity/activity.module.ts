import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Connection } from '../entities/connection.entity';
import { LastUnlock } from '../entities/last-unlock.entity';
import { ActivityController } from './activity.controller';
import { ActivityGateway } from './activity.gateway';
import { ActivityService } from './activity.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([LastUnlock, Connection]),
    JwtModule.register({ secret: process.env.JWT_SECRET || 'consnow-secret-key' }),
  ],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityGateway],
})
export class ActivityModule {}