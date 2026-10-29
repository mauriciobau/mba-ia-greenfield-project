import 'dotenv/config';
import { S3Client } from '@aws-sdk/client-s3';
import { Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { S3StorageService } from './s3-storage.service';
import {
  VIDEO_PROCESSING_CONCURRENCY,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJobData,
} from './video-queue.constants';
import { VideoWorkerService } from './video-worker.service';
import { VideosPersistenceService } from './videos.persistence.service';

async function main(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_NAME ?? 'streamtube',
    entities: [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
    synchronize: false,
  });
  const s3Config = {
    getOrThrow<T>(key: string): T {
      const value = process.env[key];
      if (!value) throw new Error(`Missing required configuration: ${key}`);
      return value as T;
    },
  };
  const s3Options = {
    endpoint: s3Config.getOrThrow<string>('S3_ENDPOINT'),
    region: s3Config.getOrThrow<string>('S3_REGION'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3Config.getOrThrow<string>('S3_ACCESS_KEY'),
      secretAccessKey: s3Config.getOrThrow<string>('S3_SECRET_KEY'),
    },
  };
  const s3 = new S3Client(s3Options);
  const publicS3 = new S3Client({
    ...s3Options,
    endpoint: s3Config.getOrThrow<string>('S3_PUBLIC_ENDPOINT'),
  });
  const storage = new S3StorageService(s3, publicS3, {
    getOrThrow: () => s3Config.getOrThrow<string>('S3_BUCKET'),
  } as never);
  const redisConnection = {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  };

  await dataSource.initialize();
  const service = new VideoWorkerService(
    dataSource,
    storage,
    new VideosPersistenceService(dataSource),
  );
  const worker = new Worker<VideoProcessingJobData>(
    VIDEO_PROCESSING_QUEUE,
    (job) => service.process(job),
    {
      connection: redisConnection,
      concurrency: VIDEO_PROCESSING_CONCURRENCY,
      lockDuration: 35 * 60 * 1000,
    },
  );
  worker.on('error', (error) => {
    process.stderr.write(`Video worker connection error: ${error.message}\n`);
  });
  process.stdout.write('Video processing worker is ready\n');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await worker.close();
    await dataSource.destroy();
    s3.destroy();
    publicS3.destroy();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Could not start video processing worker: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
