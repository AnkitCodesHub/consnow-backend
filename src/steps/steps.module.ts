import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StepsController } from './steps.controller';
import { StepsService } from './steps.service';
import { DailySteps } from '../entities/daily-steps.entity';
import { User } from '../entities/user.entity';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DailySteps, User]),
    ConnectionsModule,
  ],
  controllers: [StepsController],
  providers: [StepsService],
})
export class StepsModule {}
