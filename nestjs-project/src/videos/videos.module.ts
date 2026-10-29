import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosPersistenceService } from './videos.persistence.service';
import { S3StorageService } from './s3-storage.service';
import { UploadInitService } from './upload-init.service';
import { UploadPartsService } from './upload-parts.service';
import { UploadCompletionService } from './upload-completion.service';
import { VideoAccessService } from './video-access.service';
import { VideoUploadReconciliationService } from './video-upload-reconciliation.service';
import { VideoOutboxPublisherService } from './video-outbox-publisher.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_QUEUE_CLIENT,
} from './video-queue.constants';
import { VideosController } from './videos.controller';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './videos.constants';

@Module({
  imports: [
    ChannelsModule,
    TypeOrmModule.forFeature([Video, VideoUpload, VideoProcessingOutbox]),
  ],
  controllers: [VideosController],
  providers: [
    VideosPersistenceService,
    UploadInitService,
    UploadPartsService,
    UploadCompletionService,
    VideoAccessService,
    VideoUploadReconciliationService,
    VideoOutboxPublisherService,
    {
      provide: VIDEO_PROCESSING_QUEUE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Queue(VIDEO_PROCESSING_QUEUE, {
          connection: {
            host: config.get<string>('REDIS_HOST', 'redis'),
            port: config.get<number>('REDIS_PORT', 6379),
            maxRetriesPerRequest: null,
          },
        }),
    },
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
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new S3Client({
          endpoint: config.getOrThrow<string>('S3_PUBLIC_ENDPOINT'),
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
