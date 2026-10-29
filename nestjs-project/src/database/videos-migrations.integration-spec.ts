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

const MANAGED_TABLES = ['videos', 'video_uploads', 'video_processing_outbox'];

describe('Video migrations (integration)', () => {
  let dataSource: DataSource;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793237495685,
        ],
      },
    );
    await dataSource.initialize();

    for (const table of [
      'video_uploads',
      'video_processing_outbox',
      'videos',
    ]) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    const [{ migration_table: migrationTable }] = await dataSource.query<
      { migration_table: string | null }[]
    >(`SELECT to_regclass('public.migrations') AS migration_table`);
    if (migrationTable) {
      await dataSource.query(`DELETE FROM "migrations" WHERE "name" = $1`, [
        'CreateVideos1793237495685',
      ]);
    }

    await dataSource.runMigrations();

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
    if (dataSource?.isInitialized) {
      await dataSource.runMigrations();
      await dataSource.destroy();
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
    await dataSource.runMigrations();
  });
});
