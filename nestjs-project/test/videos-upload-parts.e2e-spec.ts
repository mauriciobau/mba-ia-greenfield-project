import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { S3_CLIENT, S3_PUBLIC_CLIENT } from '../src/videos/videos.constants';
import { User } from '../src/users/entities/user.entity';

describe('video upload parts (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let jwt: JwtService;
  let s3: S3Client;
  let publicS3: S3Client;
  let userId: string;
  let otherUserId: string;
  let channelId: string;
  let otherChannelId: string;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(S3_PUBLIC_CLIENT)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) => {
          publicS3 = new S3Client({
            endpoint: 'http://minio:9000',
            region: config.getOrThrow<string>('S3_REGION'),
            forcePathStyle: true,
            credentials: {
              accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
              secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
            },
          });
          return publicS3;
        },
      })
      .compile();
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
    s3 = moduleFixture.get(S3_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    publicS3?.destroy();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const user = await users.save(
      users.create({
        email: `video_parts_${suffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    userId = user.id;
    const channel = await channels.save(
      channels.create({
        name: 'Parts test channel',
        nickname: `parts_${suffix.replaceAll('-', '')}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    token = await jwt.signAsync({ sub: user.id, email: user.email });

    const otherSuffix = randomUUID();
    const other = await users.save(
      users.create({
        email: `video_parts_other_${otherSuffix}@example.com`,
        password: 'test-hash',
        is_confirmed: true,
      }),
    );
    otherUserId = other.id;
    const otherChannel = await channels.save(
      channels.create({
        name: 'Other parts test channel',
        nickname: `other_parts_${otherSuffix.replaceAll('-', '')}`,
        user_id: other.id,
      }),
    );
    otherChannelId = otherChannel.id;
    otherToken = await jwt.signAsync({ sub: other.id, email: other.email });
  });

  afterEach(async () => {
    const createdVideos = await videos.findBy({ channel_id: channelId });
    for (const video of createdVideos) {
      const pending = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Prefix: video.object_key,
        }),
      );
      for (const upload of pending.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: process.env.S3_BUCKET ?? 'videos',
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
    }
    if (createdVideos.length > 0) {
      await videos.delete(createdVideos.map((video) => video.id));
    }
    await channels.delete(otherChannelId);
    await channels.delete(channelId);
    await users.delete(otherUserId);
    await users.delete(userId);
  });

  async function startUpload(sizeBytes: number) {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ sizeBytes, contentType: 'video/mp4' })
      .expect(201);
    return response.body as { videoId: string; uploadId: string };
  }

  it('rejects an expired signed URL, renews it, and resumes from the ETag', async () => {
    const session = await startUpload(5 * 1024 * 1024);
    const storedSession = await uploads.findOneOrFail({
      where: { id: session.uploadId },
      relations: { video: true },
    });
    const expiredUrl = await getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Key: storedSession.video.object_key,
        UploadId: storedSession.upload_id,
        PartNumber: 1,
      }),
      {
        expiresIn: 1,
        signingDate: new Date(Date.now() - 10 * 60 * 1000),
      },
    );
    const expiredPut = await fetch(expiredUrl, {
      method: 'PUT',
      body: Buffer.alloc(5 * 1024 * 1024, 6),
    });
    expect(expiredPut.status).toBe(403);

    const signed = await request(app.getHttpServer())
      .post(`/videos/uploads/${session.uploadId}/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const signedBody = signed.body as {
      parts: { partNumber: number; url: string; expiresAt: string }[];
    };
    const partUrl = signedBody.parts[0];
    expect(new URL(partUrl.url).hostname).toBe('minio');
    expect(new Date(partUrl.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const uploaded = await fetch(partUrl.url, {
      method: 'PUT',
      body: Buffer.alloc(5 * 1024 * 1024, 7),
    });
    expect(uploaded.status).toBe(200);
    const etag = uploaded.headers.get('etag');
    expect(etag).toEqual(expect.any(String));

    const resumed = await request(app.getHttpServer())
      .get(`/videos/uploads/${session.uploadId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const resumedBody = resumed.body as {
      parts: { partNumber: number; size: number; etag: string }[];
      nextCursor: number | null;
    };
    expect(resumedBody.parts).toEqual([
      expect.objectContaining({ partNumber: 1, size: 5 * 1024 * 1024, etag }),
    ]);
    expect(resumedBody.nextCursor).toBeNull();
  }, 30000);

  it('rejects a non-owner and invalid part numbers while requiring authentication', async () => {
    const session = await startUpload(1024);
    await request(app.getHttpServer())
      .get(`/videos/uploads/${session.uploadId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/videos/uploads/${session.uploadId}/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [0] })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/videos/uploads/${session.uploadId}`)
      .expect(401);
  });
});
