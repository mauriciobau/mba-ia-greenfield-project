import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
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
import { VideoProcessingOutbox } from '../src/videos/entities/video-processing-outbox.entity';
import { VideoUpload } from '../src/videos/entities/video-upload.entity';
import { VideosPersistenceService } from '../src/videos/videos.persistence.service';
import { S3_CLIENT, VIDEO_UPLOAD } from '../src/videos/videos.constants';

const PART_SIZE_BYTES = 5 * 1024 * 1024;

describe('POST/DELETE /videos/uploads/:uploadId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let outbox: Repository<VideoProcessingOutbox>;
  let jwt: JwtService;
  let s3: S3Client;
  let persistence: VideosPersistenceService;
  let userId: string;
  let channelId: string;
  let token: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    uploads = dataSource.getRepository(VideoUpload);
    outbox = dataSource.getRepository(VideoProcessingOutbox);
    jwt = module.get(JwtService);
    s3 = module.get(S3_CLIENT);
    persistence = module.get(VideosPersistenceService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const user = await users.save(
      users.create({
        email: `video_complete_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    userId = user.id;
    const channel = await channels.save(
      channels.create({
        name: 'Video completion test channel',
        nickname: `complete_${suffix.replaceAll('-', '')}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    token = await jwt.signAsync({ sub: user.id, email: user.email });
  });

  afterEach(async () => {
    const createdVideos = await videos.findBy({ channel_id: channelId });
    for (const video of createdVideos) {
      const multipart = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Prefix: video.object_key,
        }),
      );
      for (const upload of multipart.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: process.env.S3_BUCKET ?? 'videos',
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: video.object_key,
        }),
      );
    }
    if (createdVideos.length > 0) {
      await videos.delete(createdVideos.map((video) => video.id));
    }
    await channels.delete(channelId);
    await users.delete(userId);
    jest.restoreAllMocks();
  });

  async function startUpload(sizeBytes = PART_SIZE_BYTES): Promise<{
    videoId: string;
    uploadId: string;
    objectKey: string;
    storageUploadId: string;
  }> {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes, contentType: 'video/mp4' })
      .expect(201);
    const body = response.body as { uploadId: string; videoId: string };
    const upload = await uploads.findOneByOrFail({
      id: body.uploadId,
    });
    const video = await videos.findOneByOrFail({ id: body.videoId });
    return {
      videoId: video.id,
      uploadId: upload.id,
      objectKey: video.object_key,
      storageUploadId: upload.upload_id,
    };
  }

  async function uploadPart(
    objectKey: string,
    storageUploadId: string,
    body = Buffer.alloc(PART_SIZE_BYTES, 1),
  ): Promise<void> {
    await s3.send(
      new UploadPartCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Key: objectKey,
        UploadId: storageUploadId,
        PartNumber: 1,
        Body: body,
      }),
    );
  }

  it('completes once, records processing with one outbox event, and is idempotent', async () => {
    const upload = await startUpload();
    await uploadPart(upload.objectKey, upload.storageUploadId);

    const first = await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect(first.body).toEqual({
      videoId: upload.videoId,
      status: 'processing',
    });
    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    expect((await videos.findOneByOrFail({ id: upload.videoId })).status).toBe(
      'processing',
    );
    expect((await uploads.findOneByOrFail({ id: upload.uploadId })).state).toBe(
      'completed',
    );
    expect(await outbox.findBy({ video_id: upload.videoId })).toHaveLength(1);
  });

  it('rejects missing parts without changing the draft and permits a later retry', async () => {
    const upload = await startUpload();

    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect((await uploads.findOneByOrFail({ id: upload.uploadId })).state).toBe(
      'initiated',
    );
    expect((await videos.findOneByOrFail({ id: upload.videoId })).status).toBe(
      'draft',
    );

    await uploadPart(upload.objectKey, upload.storageUploadId);
    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
  });

  it('recovers when storage completed but the database transaction initially fails', async () => {
    const upload = await startUpload();
    await uploadPart(upload.objectKey, upload.storageUploadId);
    jest
      .spyOn(persistence, 'finishUpload')
      .mockRejectedValueOnce(new Error('simulated database outage'));

    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    expect((await uploads.findOneByOrFail({ id: upload.uploadId })).state).toBe(
      'completing',
    );
    expect((await videos.findOneByOrFail({ id: upload.videoId })).status).toBe(
      'draft',
    );
    await dataSource.query(
      'UPDATE "video_uploads" SET "updated_at" = $1 WHERE "id" = $2',
      [
        new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS - 1),
        upload.uploadId,
      ],
    );

    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    expect(await outbox.findBy({ video_id: upload.videoId })).toHaveLength(1);
  });

  it('aborts idempotently, preserves the draft, and rejects completion afterward', async () => {
    const upload = await startUpload();
    await uploadPart(upload.objectKey, upload.storageUploadId);

    await request(app.getHttpServer())
      .delete(`/videos/uploads/${upload.uploadId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/videos/uploads/${upload.uploadId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await request(app.getHttpServer())
      .post(`/videos/uploads/${upload.uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect((await uploads.findOneByOrFail({ id: upload.uploadId })).state).toBe(
      'aborted',
    );
    expect((await videos.findOneByOrFail({ id: upload.videoId })).status).toBe(
      'draft',
    );
    expect(await outbox.findBy({ video_id: upload.videoId })).toHaveLength(0);
  });

  it('serializes concurrent abort and completion to one consistent winner', async () => {
    const upload = await startUpload();
    await uploadPart(upload.objectKey, upload.storageUploadId);
    const [complete, abort] = await Promise.all([
      request(app.getHttpServer())
        .post(`/videos/uploads/${upload.uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`),
      request(app.getHttpServer())
        .delete(`/videos/uploads/${upload.uploadId}`)
        .set('Authorization', `Bearer ${token}`),
    ]);

    const session = await uploads.findOneByOrFail({ id: upload.uploadId });
    const video = await videos.findOneByOrFail({ id: upload.videoId });
    const events = await outbox.findBy({ video_id: upload.videoId });
    if (session.state === 'completed') {
      expect(complete.status).toBe(202);
      expect(abort.status).toBe(409);
      expect(video.status).toBe('processing');
      expect(events).toHaveLength(1);
    } else {
      expect(session.state).toBe('aborted');
      expect(abort.status).toBe(204);
      expect(complete.status).toBe(409);
      expect(video.status).toBe('draft');
      expect(events).toHaveLength(0);
    }
  });

  it('serializes two concurrent completion requests without duplicate outbox events', async () => {
    const upload = await startUpload();
    await uploadPart(upload.objectKey, upload.storageUploadId);
    const completeRequest = () =>
      request(app.getHttpServer())
        .post(`/videos/uploads/${upload.uploadId}/complete`)
        .set('Authorization', `Bearer ${token}`);

    const responses = await Promise.all([completeRequest(), completeRequest()]);

    expect(responses.map((response) => response.status).sort()).toEqual(
      expect.arrayContaining([202]),
    );
    expect(
      responses.every((response) => [202, 409].includes(response.status)),
    ).toBe(true);
    expect((await uploads.findOneByOrFail({ id: upload.uploadId })).state).toBe(
      'completed',
    );
    expect(await outbox.findBy({ video_id: upload.videoId })).toHaveLength(1);
  });

  it('requires authentication for completion and abort', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads/missing/complete')
      .expect(401);
    await request(app.getHttpServer())
      .delete('/videos/uploads/missing')
      .expect(401);
  });
});
