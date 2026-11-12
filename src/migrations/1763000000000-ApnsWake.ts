import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * iPhone wake-ups (silent push through APNs).
 *  - users.apns_token / apns_env: where to send the wake push, and which APNs server
 *  - users.last_wake_push_at: throttle (iOS drops apps that get too many silent pushes)
 */
export class ApnsWake1763000000000 implements MigrationInterface {
  name = 'ApnsWake1763000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "apns_token" varchar(200) NULL`);
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "apns_env" varchar(16) NULL`);
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_wake_push_at" timestamptz NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_users_apns_token" ON "users" ("apns_token")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_users_apns_token"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "last_wake_push_at"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "apns_env"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "apns_token"`);
  }
}
