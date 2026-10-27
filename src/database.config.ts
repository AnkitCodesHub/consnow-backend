import { DataSourceOptions } from 'typeorm';
import { User } from './entities/user.entity';
import { Connection } from './entities/connection.entity';
import { DailySteps } from './entities/daily-steps.entity';
import { LastUnlock } from './entities/last-unlock.entity';

/**
 * One DB config for both the app and the migration CLI.
 *
 * synchronize is OFF unless DB_SYNCHRONIZE=true. With it on, TypeORM rewrites the
 * production schema on every boot to match the entity classes: a renamed or retyped
 * column is DROPPED and re-created empty, and constraints can be dropped/recreated.
 * That is why data went wrong after backend changes. Schema changes now go through
 * migrations (src/migrations), which run once, in order, on startup.
 */
export function databaseOptions(): DataSourceOptions {
  const connection = process.env.DATABASE_URL
    ? { url: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'stepshare',
      };

  return {
    type: 'postgres',
    ...connection,
    entities: [User, Connection, DailySteps, LastUnlock],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
  };
}
