import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoUploadCompletionLease1793240347823 implements MigrationInterface {
  name = 'AddVideoUploadCompletionLease1793240347823';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_uploads" ADD "completion_token" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_uploads" DROP COLUMN "completion_token"`,
    );
  }
}
