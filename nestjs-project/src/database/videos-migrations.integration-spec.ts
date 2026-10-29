import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingOutbox } from '../videos/entities/video-processing-outbox.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793237495685 } from './migrations/1793237495685-CreateVideos';
import { AddVideoUploadCompletionLease1793240347823 } from './migrations/1793240347823-AddVideoUploadCompletionLease';
import { AddVideoProcessingExecutionLease1793241000000 } from './migrations/1793241000000-AddVideoProcessingExecutionLease';

const MANAGED_TABLES = ['videos', 'video_uploads', 'video_processing_outbox'];
const MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1793237495685,
  AddVideoUploadCompletionLease1793240347823,
  AddVideoProcessingExecutionLease1793241000000,
];

describe('Video migrations (integration)', () => {
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let migrationDatabase: string;
  let migrationDatabaseCreated = false;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    migrationDatabase = `streamtube_migrations_${randomUUID().replaceAll('-', '')}`;
    adminDataSource = createTestDataSource([], {
      synchronize: false,
      database: 'postgres',
    });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${migrationDatabase}"`);
    migrationDatabaseCreated = true;

    dataSource = createTestDataSource(
      [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
      {
        synchronize: false,
        migrations: MIGRATIONS,
        database: migrationDatabase,
      },
    );
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    const ranMigrations = await dataSource.runMigrations();
    expect(ranMigrations).toHaveLength(MIGRATIONS.length);

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `video_migration_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;

    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Migration test channel',
        nickname: `migration_${Date.now()}`,
        user_id: userId,
      }),
    );
    channelId = channel.id;
  });

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } finally {
      try {
        if (adminDataSource?.isInitialized && migrationDatabaseCreated) {
          await adminDataSource.query(`DROP DATABASE "${migrationDatabase}"`);
        }
      } finally {
        if (adminDataSource?.isInitialized) await adminDataSource.destroy();
      }
    }
  });

  it('creates video tables and enforces the declared foreign and unique constraints', async () => {
    const tableRows = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    expect(tableRows.map(({ table_name }) => table_name)).toEqual([
      'video_processing_outbox',
      'video_uploads',
      'videos',
    ]);
    const completionToken = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_uploads'
         AND column_name = 'completion_token'`,
    );
    expect(completionToken).toHaveLength(1);
    const executionLease = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_processing_outbox'
         AND column_name IN ('execution_token', 'lease_expires_at', 'recovery_count')`,
    );
    expect(executionLease.map(({ column_name }) => column_name).sort()).toEqual(
      ['execution_token', 'lease_expires_at', 'recovery_count'],
    );

    const videoRepository = dataSource.getRepository(Video);
    const firstVideo = await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        public_id: 'migration_public_id',
        object_key: 'migration/object-one',
        size_bytes: '100',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channelId,
          public_id: firstVideo.public_id,
          object_key: 'migration/object-two',
          size_bytes: '100',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-4000-8000-000000000000',
          public_id: 'migration_orphan',
          object_key: 'migration/orphan',
          size_bytes: '100',
        }),
      ),
    ).rejects.toThrow();

    const persistedChannel = await dataSource
      .getRepository(Channel)
      .findOneBy({ id: channelId });
    expect(persistedChannel?.user_id).toBe(userId);
  });

  it('rolls back only video tables and preserves existing channel records', async () => {
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    const remainingVideoTables = await dataSource.query<
      { table_name: string }[]
    >(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [MANAGED_TABLES],
    );
    expect(remainingVideoTables).toHaveLength(0);

    const channel = await dataSource.getRepository(Channel).findOneBy({
      id: channelId,
    });
    expect(channel?.user_id).toBe(userId);
    const remainingAuthTables = await dataSource.query<
      { table_name: string }[]
    >(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(remainingAuthTables).toHaveLength(2);

    const reappliedMigrations = await dataSource.runMigrations();
    expect(reappliedMigrations).toHaveLength(3);
    const restoredCompletionToken = await dataSource.query<
      { column_name: string }[]
    >(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_uploads'
         AND column_name = 'completion_token'`,
    );
    expect(restoredCompletionToken).toHaveLength(1);
    const restoredExecutionLease = await dataSource.query<
      { column_name: string }[]
    >(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_processing_outbox'
         AND column_name IN ('execution_token', 'lease_expires_at', 'recovery_count')`,
    );
    expect(restoredExecutionLease).toHaveLength(3);
  });
});
