import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Instant connect / disconnect.
 *  - connections: who disconnected and when (for the Undo window)
 *  - connection_requests: one row per "Connect" tap after a disconnect
 *  - users.fcm_token: where to send push notifications
 */
export class ConnectRequests1762300800000 implements MigrationInterface {
  name = 'ConnectRequests1762300800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "disconnected_by" uuid NULL`);
    await q.query(`ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "disconnected_at" timestamptz NULL`);
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "fcm_token" varchar(512) NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "connection_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "from_user_id" uuid NOT NULL,
        "to_user_id" uuid NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "responded_at" timestamptz NULL,
        CONSTRAINT "PK_connection_requests_id" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_conn_req_to_status" ON "connection_requests" ("to_user_id", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_conn_req_pair" ON "connection_requests" ("from_user_id", "to_user_id", "created_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "connection_requests"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "fcm_token"`);
    await q.query(`ALTER TABLE "connections" DROP COLUMN IF EXISTS "disconnected_at"`);
    await q.query(`ALTER TABLE "connections" DROP COLUMN IF EXISTS "disconnected_by"`);
  }
}
