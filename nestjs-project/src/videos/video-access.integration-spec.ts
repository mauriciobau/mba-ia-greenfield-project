import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createIsolatedVideoDataSource } from '../test/create-isolated-video-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { S3StorageService } from './s3-storage.service';
import { VideoAccessService } from './video-access.service';
import { VideosPersistenceService } from './videos.persistence.service';

describe('Video access and signed S3 URLs (integration)', () => {
  let dataSource: DataSource;
  let cleanupDatabase: () => Promise<void>;
  let s3: S3Client;
  let publicClient: S3Client;
  let storage: S3StorageService;
  let access: VideoAccessService;
  let owner: User;
  let channel: Channel;
  let video: Video;
  const bucket = process.env.S3_BUCKET ?? 'videos';
  const body = Buffer.from('streamtube range response body');

  beforeAll(async () => {
    const isolated = await createIsolatedVideoDataSource();
    dataSource = isolated.dataSource;
    cleanupDatabase = isolated.cleanup;
    const clientOptions = {
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'streamtube',
        secretAccessKey:
          process.env.S3_SECRET_KEY ?? 'streamtube-local-password',
      },
    };
    s3 = new S3Client(clientOptions);
    publicClient = new S3Client({
      ...clientOptions,
      endpoint: 'http://minio:9000',
    });
    const config = {
      getOrThrow: (key: string) => (key === 'S3_BUCKET' ? bucket : undefined),
    } as ConfigService;
    storage = new S3StorageService(s3, publicClient, config);
    access = new VideoAccessService(
      new VideosPersistenceService(dataSource),
      storage,
    );
  });

  afterAll(async () => {
    s3?.destroy();
    publicClient?.destroy();
    await cleanupDatabase?.();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const videos = dataSource.getRepository(Video);
    owner = await users.save(
      users.create({
        email: `video_access_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    channel = await channels.save(
      channels.create({
        name: 'Video access integration channel',
        nickname: `access_${suffix.replaceAll('-', '')}`,
        user_id: owner.id,
      }),
    );
    video = await videos.save(
      videos.create({
        channel_id: channel.id,
        public_id: `access-${suffix}`,
        object_key: `integration-tests/${suffix}/source`,
        status: 'ready',
        size_bytes: String(body.byteLength),
        duration_ms: '1000',
        metadata: { videoCodec: 'h264' },
        error_code: null,
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: video.object_key,
        Body: body,
        ContentType: 'video/mp4',
      }),
    );
  });

  afterEach(async () => {
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: video.object_key }),
    );
    await dataSource.getRepository(Video).delete(video.id);
    await dataSource.getRepository(Channel).delete(channel.id);
    await dataSource.getRepository(User).delete(owner.id);
  });

  it('serves a real partial response and download disposition from MinIO', async () => {
    const playback = await access.createPlaybackUrl(owner.id, video.public_id);
    const playbackResponse = await fetch(playback.url, {
      headers: { Range: 'bytes=0-6' },
    });

    expect(playbackResponse.status).toBe(206);
    expect(playbackResponse.headers.get('content-range')).toBe(
      `bytes 0-6/${body.byteLength}`,
    );
    expect(Buffer.from(await playbackResponse.arrayBuffer())).toEqual(
      body.subarray(0, 7),
    );
    expect(playbackResponse.headers.get('content-disposition')).toContain(
      'inline',
    );

    const download = await access.createDownloadUrl(owner.id, video.public_id);
    const downloadResponse = await fetch(download.url);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-disposition')).toBe(
      `attachment; filename="video-${video.public_id}.mp4"`,
    );
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(body);
  }, 30000);

  it('renews a real signed URL for its owner and never signs a non-ready video', async () => {
    const initial = await access.createPlaybackUrl(owner.id, video.public_id);
    const renewed = await access.createPlaybackUrl(owner.id, video.public_id);
    expect(new URL(initial.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now());

    video.status = 'processing';
    await dataSource.getRepository(Video).save(video);
    await expect(
      access.createPlaybackUrl(owner.id, video.public_id),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_READY', httpStatus: 409 });
  }, 30000);
});
