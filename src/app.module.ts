import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ConnectionsModule } from './connections/connections.module';
import { StepsModule } from './steps/steps.module';
import { ActivityModule } from './activity/activity.module';
import { databaseOptions } from './database.config';

@Module({
  imports: [
    // Schema is managed by migrations, not rewritten on every deploy (see database.config.ts)
    TypeOrmModule.forRoot({
      ...databaseOptions(),
      migrationsRun: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        // per client IP; one walking phone alone sends ~90 req/min, and a family on
        // the same Wi-Fi shares one IP
        limit: 600,
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