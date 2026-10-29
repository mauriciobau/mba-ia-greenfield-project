import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with the exported ChannelsService and persistence providers', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              S3_ENDPOINT: 'http://minio:9000',
              S3_REGION: 'us-east-1',
              S3_ACCESS_KEY: 'test',
              S3_SECRET_KEY: 'test',
              S3_BUCKET: 'videos',
            }),
          ],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource([
            User,
            Channel,
            Video,
            VideoUpload,
            VideoProcessingOutbox,
          ]).options,
        ),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
