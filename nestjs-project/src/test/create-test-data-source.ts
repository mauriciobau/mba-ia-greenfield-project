import { DataSource, DataSourceOptions, MigrationInterface } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingOutbox } from '../videos/entities/video-processing-outbox.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';

const CHANNEL_RELATED_ENTITIES = [Video, VideoUpload, VideoProcessingOutbox];
type TestEntity = Extract<
  NonNullable<DataSourceOptions['entities']>,
  readonly unknown[]
>[number];

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: TestEntity[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  const configuredEntities = entities.includes(Channel)
    ? [...new Set([...entities, ...CHANNEL_RELATED_ENTITIES])]
    : entities;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities: configuredEntities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "video_uploads"');
  await dataSource.query('DELETE FROM "video_processing_outbox"');
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
