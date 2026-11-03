import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProfileViews1762156800000 implements MigrationInterface {
  name = 'CreateProfileViews1762156800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "profile_views" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "viewer_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "viewed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_profile_views_id" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_profile_views_owner_viewed" ON "profile_views" ("owner_id", "viewed_at")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_profile_views_viewer_owner" ON "profile_views" ("viewer_id", "owner_id", "viewed_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "profile_views"`);
  }
}
