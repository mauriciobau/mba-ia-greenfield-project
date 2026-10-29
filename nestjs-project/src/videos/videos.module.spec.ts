import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createIsolatedVideoDataSource } from '../test/create-isolated-video-data-source';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with the exported ChannelsService and persistence providers', async () => {
    const isolated = await createIsolatedVideoDataSource();
    const typeOrmOptions = isolated.dataSource.options;
    await isolated.dataSource.destroy();
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                S3_ENDPOINT: 'http://minio:9000',
                S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
                S3_REGION: 'us-east-1',
                S3_ACCESS_KEY: 'test',
                S3_SECRET_KEY: 'test',
                S3_BUCKET: 'videos',
              }),
            ],
          }),
          TypeOrmModule.forRoot(typeOrmOptions),
          VideosModule,
        ],
      }).compile();

      expect(module).toBeDefined();
    } finally {
      await module?.close();
      await isolated.cleanup();
    }
  }, 30000);
});
