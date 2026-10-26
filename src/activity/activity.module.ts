import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Connection } from '../entities/connection.entity';
import { LastUnlock } from '../entities/last-unlock.entity';
import { ActivityController } from './activity.controller';
import { ActivityGateway } from './activity.gateway';
import { ActivityService } from './activity.service';
import { User } from '../entities/user.entity';
import { StepsModule } from '../steps/steps.module';
import { getJwtSecret } from '../auth/jwt-secret';

@Module({
   imports: [
    TypeOrmModule.forFeature([LastUnlock, Connection, User]),
        JwtModule.register({ secret: getJwtSecret() }),
    StepsModule,
  ],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityGateway],
})
export class ActivityModule {}