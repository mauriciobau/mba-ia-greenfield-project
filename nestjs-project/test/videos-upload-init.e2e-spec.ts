import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Video } from '../src/videos/entities/video.entity';
import { VideoUpload } from '../src/videos/entities/video-upload.entity';
import {
  MultipartUploadCleanupFailedError,
  S3StorageService,
} from '../src/videos/s3-storage.service';
import { S3_CLIENT } from '../src/videos/videos.constants';
import { VideosPersistenceService } from '../src/videos/videos.persistence.service';
import { User } from '../src/users/entities/user.entity';
import type { InitVideoUploadResponse } from '../src/videos/upload-init.service';

describe('POST /videos/uploads (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let jwt: JwtService;
  let storage: S3StorageService;
  let s3Client: S3Client;
  let userId: string;
  let channelId: string;
  let otherUserId: string;
  let otherChannelId: string;
  let token: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

    dataSource = moduleFixture.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    uploads = dataSource.getRepository(VideoUpload);
    jwt = moduleFixture.get(JwtService);
    storage = moduleFixture.get(S3StorageService);
    s3Client = moduleFixture.get(S3_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const user = await users.save(
      users.create({
        email: `video_upload_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    userId = user.id;
    const channel = await channels.save(
      channels.create({
        name: 'Upload test channel',
        nickname: `upload_${suffix.replaceAll('-', '')}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    const otherSuffix = randomUUID();
    const otherUser = await users.save(
      users.create({
        email: `video_upload_other_${otherSuffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    otherUserId = otherUser.id;
    const otherChannel = await channels.save(
      channels.create({
        name: 'Other upload test channel',
        nickname: `other_${otherSuffix.replaceAll('-', '')}`,
        user_id: otherUser.id,
      }),
    );
    otherChannelId = otherChannel.id;
    token = await jwt.signAsync({ sub: user.id, email: user.email });
  });

  afterEach(async () => {
    if (!dataSource) return;
    const createdVideos = await videos.findBy({ channel_id: channelId });
    const pending = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Prefix: `videos/${channelId}/`,
      }),
    );
    for (const pendingUpload of pending.Uploads ?? []) {
      if (!pendingUpload.Key || !pendingUpload.UploadId) continue;
      await s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: pendingUpload.Key,
          UploadId: pendingUpload.UploadId,
        }),
      );
    }
    if (createdVideos.length > 0) {
      await videos.delete(createdVideos.map((video) => video.id));
    }
    await channels.delete(otherChannelId);
    await channels.delete(channelId);
    await users.delete(otherUserId);
    await users.delete(userId);
    jest.restoreAllMocks();
  });

  it('creates a draft and persists its owned multipart session', async () => {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(201);

    const body = response.body as InitVideoUploadResponse;
    expect(body).toMatchObject({
      status: 'draft',
      partSizeBytes: 67108864,
    });
    expect(body.videoId).toEqual(expect.any(String));
    expect(body.uploadId).toEqual(expect.any(String));
    const video = await videos.findOneByOrFail({ id: body.videoId });
    const upload = await uploads.findOneByOrFail({ id: body.uploadId });
    expect(video.channel_id).toBe(channelId);
    expect(video.channel_id).not.toBe(otherChannelId);
    expect(video.status).toBe('draft');
    expect(upload.video_id).toBe(video.id);
    expect(upload.state).toBe('initiated');
    expect(body.uploadId).not.toBe(upload.upload_id);
    expect(JSON.stringify(body)).not.toContain(upload.upload_id);
  });

  it('returns 413 for a size over 10,000,000,000 bytes without creating a session', async () => {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 10_000_000_001, contentType: 'video/mp4' })
      .expect(413);

    expect((response.body as { error: string }).error).toBe(
      'VIDEO_UPLOAD_TOO_LARGE',
    );
    expect(await videos.countBy({ channel_id: channelId })).toBe(0);
    const pending = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Prefix: `videos/${channelId}/`,
      }),
    );
    expect(pending.Uploads ?? []).toHaveLength(0);
  });

  it('accepts exactly 10,000,000,000 bytes without buffering the media', async () => {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 10_000_000_000, contentType: 'video/mp4' })
      .expect(201);

    const body = response.body as InitVideoUploadResponse;
    const upload = await uploads.findOneByOrFail({ id: body.uploadId });
    expect(upload.expected_size_bytes).toBe('10000000000');
    expect(body.status).toBe('draft');
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(401);
  });

  it('removes the draft when storage initiation fails', async () => {
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValue(new Error('MinIO network timeout'));

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(503);

    expect((response.body as { error: string }).error).toBe(
      'VIDEO_STORAGE_UNAVAILABLE',
    );
    expect(await videos.countBy({ channel_id: channelId })).toBe(0);
  });

  it('preserves the draft key when cleanup after storage initiation fails', async () => {
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValue(new MultipartUploadCleanupFailedError());

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(503);

    expect((response.body as { error: string }).error).toBe(
      'VIDEO_STORAGE_UNAVAILABLE',
    );
    const drafts = await videos.findBy({ channel_id: channelId });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].object_key.startsWith(`videos/${channelId}/`)).toBe(true);
    expect(await uploads.findBy({ video_id: drafts[0].id })).toHaveLength(0);
  });

  it('aborts the storage session when database persistence fails', async () => {
    const keyPrefix = `videos/${channelId}/`;
    const persist = jest
      .spyOn(app.get(VideosPersistenceService), 'createUploadSession')
      .mockRejectedValueOnce(new Error('simulated database write failure'));

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(500);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(await videos.countBy({ channel_id: channelId })).toBe(0);
    const pending = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Prefix: keyPrefix,
      }),
    );
    expect(pending.Uploads ?? []).toHaveLength(0);
  });

  it('preserves the draft key when abort compensation remains unavailable', async () => {
    jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockRejectedValue(new Error('MinIO remains unavailable'));
    jest
      .spyOn(app.get(VideosPersistenceService), 'createUploadSession')
      .mockRejectedValueOnce(new Error('simulated database write failure'));

    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'video/mp4' })
      .expect(503);

    expect((response.body as { error: string }).error).toBe(
      'VIDEO_STORAGE_UNAVAILABLE',
    );
    const drafts = await videos.findBy({ channel_id: channelId });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].object_key.startsWith(`videos/${channelId}/`)).toBe(true);
    expect(await uploads.findBy({ video_id: drafts[0].id })).toHaveLength(0);
  });

  it('rejects a content type outside the contract before creating storage resources', async () => {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes: 1024, contentType: 'application/octet-stream' })
      .expect(400);

    expect((response.body as { error: string }).error).toBe('VALIDATION_ERROR');
    expect(await videos.countBy({ channel_id: channelId })).toBe(0);
  });
});
