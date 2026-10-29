import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosPersistenceService } from './videos.persistence.service';
import { S3StorageService } from './s3-storage.service';
import { UploadInitService } from './upload-init.service';
import { VideosController } from './videos.controller';
import { S3_CLIENT } from './videos.constants';

@Module({
  imports: [
    ChannelsModule,
    TypeOrmModule.forFeature([Video, VideoUpload, VideoProcessingOutbox]),
  ],
  controllers: [VideosController],
  providers: [
    VideosPersistenceService,
    UploadInitService,
    S3StorageService,
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new S3Client({
          endpoint: config.getOrThrow<string>('S3_ENDPOINT'),
          region: config.getOrThrow<string>('S3_REGION'),
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
            secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
          },
        }),
    },
  ],
  exports: [VideosPersistenceService],
})
export class VideosModule {}
