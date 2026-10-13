import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ConnectionsModule } from './connections/connections.module';
import { StepsModule } from './steps/steps.module';
import { ActivityModule } from './activity/activity.module';
import { User } from './entities/user.entity';
import { Connection } from './entities/connection.entity';
import { DailySteps } from './entities/daily-steps.entity';
import { LastUnlock } from './entities/last-unlock.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...(process.env.DATABASE_URL
        ? {
            url: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
          }
        : {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            username: process.env.DB_USERNAME || 'postgres',
            password: process.env.DB_PASSWORD || 'postgres',
            database: process.env.DB_NAME || 'stepshare',
          }),
      entities: [User, Connection, DailySteps, LastUnlock],  // ← added LastUnlock
      synchronize: true,
    }),                    // ← TypeOrmModule.forRoot closes here
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 120,
      },
    ]),
    AuthModule,
    ConnectionsModule,
    StepsModule,
    ActivityModule,        // ← correctly placed in imports array
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}