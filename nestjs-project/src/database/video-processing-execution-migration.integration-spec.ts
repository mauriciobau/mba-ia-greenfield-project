import { DataSource } from 'typeorm';
import { createIsolatedVideoDataSource } from '../test/create-isolated-video-data-source';

describe('Video processing execution lease migration (integration)', () => {
  let dataSource: DataSource;
  let cleanupDatabase: () => Promise<void>;

  beforeAll(async () => {
    const isolated = await createIsolatedVideoDataSource();
    dataSource = isolated.dataSource;
    cleanupDatabase = isolated.cleanup;
  });

  afterAll(async () => {
    await cleanupDatabase?.();
  });

  it('adds the execution fence and bounded recovery columns and rolls them back', async () => {
    const columns = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_processing_outbox'
         AND column_name IN ('execution_token', 'lease_expires_at', 'recovery_count')`,
    );
    expect(columns.map(({ column_name }) => column_name).sort()).toEqual([
      'execution_token',
      'lease_expires_at',
      'recovery_count',
    ]);

    await dataSource.undoLastMigration();

    const rolledBackColumns = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_processing_outbox'
         AND column_name IN ('execution_token', 'lease_expires_at', 'recovery_count')`,
    );
    expect(rolledBackColumns).toHaveLength(0);
  });
});
