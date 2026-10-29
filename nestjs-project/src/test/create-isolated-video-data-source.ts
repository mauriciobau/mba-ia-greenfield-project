import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CreateAuthTokens1777579850478 } from '../database/migrations/1777579850478-CreateAuthTokens';
import { CreateUsersAndChannels1775687773260 } from '../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateVideos1793237495685 } from '../database/migrations/1793237495685-CreateVideos';
import { AddVideoUploadCompletionLease1793240347823 } from '../database/migrations/1793240347823-AddVideoUploadCompletionLease';
import { AddVideoProcessingExecutionLease1793241000000 } from '../database/migrations/1793241000000-AddVideoProcessingExecutionLease';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingOutbox } from '../videos/entities/video-processing-outbox.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from './create-test-data-source';

const MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1793237495685,
  AddVideoUploadCompletionLease1793240347823,
  AddVideoProcessingExecutionLease1793241000000,
];

export async function createIsolatedVideoDataSource(): Promise<{
  dataSource: DataSource;
  cleanup: () => Promise<void>;
}> {
  const database = `streamtube_video_test_${randomUUID().replaceAll('-', '')}`;
  const adminDataSource = createTestDataSource([], {
    synchronize: false,
    database: 'postgres',
  });
  await adminDataSource.initialize();
  await adminDataSource.query(`CREATE DATABASE "${database}"`);

  const dataSource = createTestDataSource(
    [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
    { synchronize: false, migrations: MIGRATIONS, database },
  );
  try {
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    const migrations = await dataSource.runMigrations();
    if (migrations.length !== MIGRATIONS.length) {
      throw new Error(
        'The isolated database did not apply all video migrations',
      );
    }
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy();
    await adminDataSource.query(`DROP DATABASE "${database}"`);
    await adminDataSource.destroy();
    throw error;
  }

  return {
    dataSource,
    cleanup: async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
      await adminDataSource.query(`DROP DATABASE "${database}"`);
      await adminDataSource.destroy();
    },
  };
}
