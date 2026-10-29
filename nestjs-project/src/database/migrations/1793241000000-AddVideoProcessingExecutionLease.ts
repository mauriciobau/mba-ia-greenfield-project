import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoProcessingExecutionLease1793241000000 implements MigrationInterface {
  name = 'AddVideoProcessingExecutionLease1793241000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD "execution_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD "lease_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD "recovery_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD CONSTRAINT "CHK_video_processing_outbox_recovery_count" CHECK ("recovery_count" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" ADD CONSTRAINT "CHK_video_processing_outbox_execution_lease" CHECK (("execution_token" IS NULL) = ("lease_expires_at" IS NULL))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP CONSTRAINT "CHK_video_processing_outbox_recovery_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP CONSTRAINT "CHK_video_processing_outbox_execution_lease"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP COLUMN "lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP COLUMN "recovery_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_outbox" DROP COLUMN "execution_token"`,
    );
  }
}
