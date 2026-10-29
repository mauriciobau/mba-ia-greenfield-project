import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793237495685 implements MigrationInterface {
  name = 'CreateVideos1793237495685';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "video_processing_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "generation" integer NOT NULL, "state" character varying NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_video_processing_outbox_video_generation" UNIQUE ("video_id", "generation"), CONSTRAINT "CHK_video_processing_outbox_generation" CHECK ("generation" > 0), CONSTRAINT "CHK_video_processing_outbox_state" CHECK ("state" IN ('pending', 'published')), CONSTRAINT "PK_39dcfd3c9dbeb68310241a09b72" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "video_uploads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "upload_id" text NOT NULL, "expected_size_bytes" bigint NOT NULL, "part_size_bytes" bigint NOT NULL, "state" character varying NOT NULL DEFAULT 'initiated', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_06a943c51e95702c3e84693180" UNIQUE ("video_id"), CONSTRAINT "CHK_video_uploads_sizes" CHECK ("expected_size_bytes" > 0 AND "expected_size_bytes" <= 10000000000 AND "part_size_bytes" > 0), CONSTRAINT "CHK_video_uploads_state" CHECK ("state" IN ('initiated', 'completing', 'completed', 'aborted')), CONSTRAINT "PK_c3def71eaaba3a49539786ef82a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "public_id" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'draft', "object_key" character varying NOT NULL, "thumbnail_key" character varying, "size_bytes" bigint NOT NULL, "duration_ms" bigint, "metadata" jsonb, "error_code" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_videos_size_bytes" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10000000000), CONSTRAINT "CHK_videos_status" CHECK ("status" IN ('draft', 'processing', 'ready', 'error')), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_videos_object_key" ON "videos" ("object_key") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_videos_public_id" ON "videos" ("public_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD CONSTRAINT "FK_b5164922ea5553e56eeb637863a" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_uploads" ADD CONSTRAINT "FK_06a943c51e95702c3e84693180f" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_uploads" DROP CONSTRAINT "FK_06a943c51e95702c3e84693180f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP CONSTRAINT "FK_b5164922ea5553e56eeb637863a"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_videos_public_id"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_videos_object_key"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TABLE "video_uploads"`);
    await queryRunner.query(`DROP TABLE "video_processing_outbox"`);
  }
}
