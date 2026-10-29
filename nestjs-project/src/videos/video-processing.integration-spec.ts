import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createIsolatedVideoDataSource } from '../test/create-isolated-video-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { S3StorageService } from './s3-storage.service';
import {
  VIDEO_PROCESSING_CONCURRENCY,
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJobData,
  videoProcessingJobId,
} from './video-queue.constants';
import { VideosPersistenceService } from './videos.persistence.service';
import { VideoWorkerService } from './video-worker.service';

const execFile = promisify(execFileCallback);

describe('Video processing worker (integration)', () => {
  let dataSource: DataSource;
  let persistence: VideosPersistenceService;
  let client: S3Client;
  let storage: S3StorageService;
  let workerService: VideoWorkerService;
  let cleanupDatabase: () => Promise<void>;
  let activeQueue: Queue<VideoProcessingJobData> | undefined;
  let activeWorker: Worker<VideoProcessingJobData> | undefined;
  let userId: string;
  let channelId: string;
  let videoId: string;
  let eventId: string;
  let sourceKey: string;
  let fixtureDir: string;
  let thumbnailKey: string | null;
  const bucket = process.env.S3_BUCKET ?? 'videos';
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const isolated = await createIsolatedVideoDataSource();
    dataSource = isolated.dataSource;
    cleanupDatabase = isolated.cleanup;
    persistence = new VideosPersistenceService(dataSource);
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'streamtube',
        secretAccessKey:
          process.env.S3_SECRET_KEY ?? 'streamtube-local-password',
      },
    });
    const config = {
      getOrThrow: (key: string) => (key === 'S3_BUCKET' ? bucket : undefined),
    } as ConfigService;
    storage = new S3StorageService(client, client, config);
    workerService = new VideoWorkerService(dataSource, storage, persistence);
  });

  afterAll(async () => {
    await activeWorker?.close();
    await activeQueue?.obliterate({ force: true });
    await activeQueue?.close();
    client?.destroy();
    await cleanupDatabase?.();
  });

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(join(tmpdir(), 'video-processing-fixture-'));
    const fixture = join(fixtureDir, 'valid.mp4');
    await execFile(
      process.env.FFMPEG_PATH ?? 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=2',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-filter_complex_threads',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        fixture,
      ],
      { timeout: 30_000 },
    );
    const fixtureBuffer = await fs.readFile(fixture);
    sourceKey = `integration-tests/${suffix}/${randomSuffix()}/source.mp4`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sourceKey,
        Body: fixtureBuffer,
        ContentType: 'video/mp4',
      }),
    );
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `video_worker_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Video processing integration',
        nickname: `video_worker_${suffix}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    const video = await persistence.createDraft(
      channel.id,
      sourceKey,
      String(fixtureBuffer.byteLength),
    );
    videoId = video.id;
    await persistence.startProcessing(video.id, 1);
    await dataSource
      .getRepository(VideoProcessingOutbox)
      .update({ video_id: video.id, generation: 1 }, { state: 'published' });
    eventId = (
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .findOneByOrFail({ video_id: video.id, generation: 1 })
    ).id;
    thumbnailKey = null;
  });

  afterEach(async () => {
    if (thumbnailKey) await storage.deleteObject(thumbnailKey);
    if (sourceKey)
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }),
      );
    if (videoId) await dataSource.getRepository(Video).delete({ id: videoId });
    if (channelId)
      await dataSource.getRepository(Channel).delete({ id: channelId });
    if (userId) await dataSource.getRepository(User).delete({ id: userId });
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function job(): Job<VideoProcessingJobData> {
    return {
      data: { eventId, videoId, generation: 1 },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<VideoProcessingJobData>;
  }

  it('consumes a Redis job, probes a real MP4, and saves a real thumbnail before ready', async () => {
    const queueName = `${VIDEO_PROCESSING_QUEUE}-processing-test-${suffix}`;
    const connection = {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    };
    activeQueue = new Queue<VideoProcessingJobData>(queueName, { connection });
    activeWorker = new Worker<VideoProcessingJobData>(
      queueName,
      (work) => workerService.process(work),
      { connection, concurrency: VIDEO_PROCESSING_CONCURRENCY },
    );
    const jobId = videoProcessingJobId(videoId, 1);
    await activeQueue.add(
      VIDEO_PROCESSING_JOB,
      { eventId, videoId, generation: 1 },
      { jobId, attempts: 3 },
    );
    const deadline = Date.now() + 45_000;
    let video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    while (video.status === 'processing' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
    }
    await activeWorker.close();
    activeWorker = undefined;
    expect(video.status).toBe('ready');

    expect(video).toMatchObject({
      status: 'ready',
      duration_ms: '2000',
      metadata: {
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        width: 320,
        height: 240,
      },
    });
    expect(video.thumbnail_key).toMatch(/generation-1/);
    thumbnailKey = video.thumbnail_key;
    const thumbnail = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: thumbnailKey! }),
    );
    expect(thumbnail.ContentType).toBe('image/jpeg');
    expect(thumbnail.ContentLength).toBeGreaterThan(0);
  }, 60_000);

  it('uses a PostgreSQL advisory lease to avoid concurrent execution of one generation', async () => {
    let releaseDownload: (() => void) | undefined;
    let startedDownload: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      startedDownload = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const delegatedStorage = new S3StorageService(client, client, {
      getOrThrow: () => bucket,
    } as unknown as ConfigService);
    const downloadSpy = jest
      .spyOn(storage, 'downloadObjectToFile')
      .mockImplementation(async (key, path, signal) => {
        startedDownload?.();
        await downloadGate;
        return delegatedStorage.downloadObjectToFile(key, path, signal);
      });

    const first = workerService.process(job());
    await downloadStarted;
    await workerService.process(job());
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    releaseDownload?.();
    await first;
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    expect(video.status).toBe('ready');
    thumbnailKey = video.thumbnail_key;
  }, 60_000);

  it('marks an unreadable uploaded file as error without persisting a thumbnail', async () => {
    const invalidMedia = Buffer.from('not a media container');
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: sourceKey,
        Body: invalidMedia,
      }),
    );
    await dataSource
      .getRepository(Video)
      .update({ id: videoId }, { size_bytes: String(invalidMedia.byteLength) });

    await expect(workerService.process(job())).rejects.toThrow(
      'ffprobe could not inspect uploaded media',
    );

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    expect(video.status).toBe('error');
    expect(video.error_code).toBe('VIDEO_INVALID_MEDIA');
    expect(video.thumbnail_key).toBeNull();
  });

  it('fences an expired execution token from changing a later attempt result', async () => {
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    expect(
      await persistence.claimProcessingExecution(
        eventId,
        videoId,
        1,
        firstToken,
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await persistence.claimProcessingExecution(
        eventId,
        videoId,
        1,
        secondToken,
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
    await dataSource.query(
      `UPDATE video_processing_outbox SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE video_id = $1 AND generation = 1`,
      [videoId],
    );
    expect(
      await persistence.claimProcessingExecution(
        eventId,
        videoId,
        1,
        secondToken,
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    const winningThumbnail = `videos/${videoId}/generation-1/attempt-${secondToken}.jpg`;
    expect(
      await persistence.markVideoReady(eventId, videoId, 1, firstToken, {
        thumbnail_key: `videos/${videoId}/generation-1/attempt-${firstToken}.jpg`,
        duration_ms: '2000',
        metadata: { video_codec: 'h264' },
      }),
    ).toBe(false);
    expect(
      await persistence.markVideoReady(eventId, videoId, 1, secondToken, {
        thumbnail_key: winningThumbnail,
        duration_ms: '2000',
        metadata: { video_codec: 'h264' },
      }),
    ).toBe(true);
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    expect(video.thumbnail_key).toBe(winningThumbnail);
  });
});

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}
