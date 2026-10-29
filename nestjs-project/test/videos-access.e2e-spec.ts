import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from '../src/videos/videos.constants';

describe('Video access endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let jwt: JwtService;
  let s3: S3Client;
  let testPublicClient: S3Client;
  let owner: User;
  let otherUser: User;
  let channel: Channel;
  let otherChannel: Channel;
  let video: Video;
  let token: string;
  let otherToken: string;
  let configuredS3PublicEndpoint: string | undefined;
  const bucket = process.env.S3_BUCKET ?? 'videos';
  const content = Buffer.from('streamtube e2e range and download fixture');

  beforeAll(async () => {
    configuredS3PublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(S3_PUBLIC_CLIENT)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) => {
          testPublicClient = new S3Client({
            endpoint: 'http://minio:9000',
            region: config.getOrThrow<string>('S3_REGION'),
            forcePathStyle: true,
            credentials: {
              accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
              secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
            },
          });
          return testPublicClient;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = module.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    jwt = module.get(JwtService);
    s3 = module.get(S3_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    testPublicClient?.destroy();
    if (configuredS3PublicEndpoint === undefined) {
      delete process.env.S3_PUBLIC_ENDPOINT;
    } else {
      process.env.S3_PUBLIC_ENDPOINT = configuredS3PublicEndpoint;
    }
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    owner = await users.save(
      users.create({
        email: `video_access_owner_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    channel = await channels.save(
      channels.create({
        name: 'Video access owner channel',
        nickname: `access_owner_${suffix.replaceAll('-', '')}`,
        user_id: owner.id,
      }),
    );
    otherUser = await users.save(
      users.create({
        email: `video_access_other_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    otherChannel = await channels.save(
      channels.create({
        name: 'Video access other channel',
        nickname: `access_other_${suffix.replaceAll('-', '')}`,
        user_id: otherUser.id,
      }),
    );
    token = await jwt.signAsync({ sub: owner.id, email: owner.email });
    otherToken = await jwt.signAsync({
      sub: otherUser.id,
      email: otherUser.email,
    });
    video = await videos.save(
      videos.create({
        channel_id: channel.id,
        public_id: `access-${suffix}`,
        object_key: `e2e-tests/${suffix}/source`,
        status: 'ready',
        size_bytes: String(content.byteLength),
        duration_ms: '1000',
        metadata: { videoCodec: 'h264' },
        error_code: null,
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: video.object_key,
        Body: content,
        ContentType: 'video/mp4',
      }),
    );
  });

  afterEach(async () => {
    if (video) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: video.object_key }),
      );
      await videos.delete(video.id);
    }
    if (otherChannel) await channels.delete(otherChannel.id);
    if (channel) await channels.delete(channel.id);
    if (otherUser) await users.delete(otherUser.id);
    if (owner) await users.delete(owner.id);
    jest.restoreAllMocks();
  });

  it('allows only the owner to inspect a video and requires authentication', async () => {
    const response = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      publicId: video.public_id,
      status: 'ready',
      sizeBytes: content.byteLength,
      durationMs: 1000,
      metadata: { videoCodec: 'h264' },
      errorCode: null,
    });

    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(401);
  });

  it('streams a real byte range, downloads with attachment headers, and renews URLs', async () => {
    const playback = await request(app.getHttpServer())
      .post(`/videos/${video.public_id}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const playbackBody = playback.body as { url: string; expiresAt: string };
    expect(new URL(playbackBody.url).origin).toBe('http://minio:9000');
    expect(new Date(playbackBody.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const playbackResponse = await fetch(playbackBody.url, {
      headers: { Range: 'bytes=0-7' },
    });
    expect(playbackResponse.status).toBe(206);
    expect(playbackResponse.headers.get('content-range')).toBe(
      `bytes 0-7/${content.byteLength}`,
    );
    expect(Buffer.from(await playbackResponse.arrayBuffer())).toEqual(
      content.subarray(0, 8),
    );

    const download = await request(app.getHttpServer())
      .post(`/videos/${video.public_id}/download-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const downloadBody = download.body as { url: string; expiresAt: string };
    const downloadResponse = await fetch(downloadBody.url);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-disposition')).toBe(
      `attachment; filename="video-${video.public_id}.mp4"`,
    );
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(content);

    const renewed = await request(app.getHttpServer())
      .post(`/videos/${video.public_id}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const renewedBody = renewed.body as { url: string; expiresAt: string };
    expect(new Date(renewedBody.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(new URL(renewedBody.url).searchParams.get('X-Amz-Expires')).toBe(
      '300',
    );
    expect(JSON.stringify(renewed.body)).not.toContain(
      process.env.S3_SECRET_KEY ?? 'streamtube-local-password',
    );
  }, 30000);

  it('blocks non-ready state and rejects URL requests from non-owners', async () => {
    video.status = 'processing';
    await videos.save(video);
    const response = await request(app.getHttpServer())
      .post(`/videos/${video.public_id}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((response.body as { error: string }).error).toBe('VIDEO_NOT_READY');

    await request(app.getHttpServer())
      .post(`/videos/${video.public_id}/download-url`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });
});
