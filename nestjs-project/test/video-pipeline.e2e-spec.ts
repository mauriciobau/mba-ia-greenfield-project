import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoUpload } from '../src/videos/entities/video-upload.entity';
import {
  S3_CLIENT,
  S3_PUBLIC_CLIENT,
  VIDEO_UPLOAD,
} from '../src/videos/videos.constants';

const execFile = promisify(execFileCallback);
const LARGE_UPLOAD_BYTES = VIDEO_UPLOAD.MAX_SIZE_BYTES;
const enabled = process.env.VIDEO_10GB_ACCEPTANCE === '1';

interface SignedUploadPart {
  partNumber: number;
  url: string;
}

function uploadPartsInChild(
  fixturePath: string,
  parts: SignedUploadPart[],
): Promise<void> {
  const uploader = fork(join(__dirname, 'video-upload-parts-client.js'), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  uploader.stderr?.setEncoding('utf8');
  uploader.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      uploader.kill();
      reject(error);
    };

    uploader.on('error', fail);
    uploader.on('message', (message: { type: string; error?: string }) => {
      if (message.type === 'complete' && !settled) {
        settled = true;
        resolve();
      } else if (message.type === 'error') {
        fail(new Error(message.error ?? stderr ?? 'Upload child failed'));
      }
    });
    uploader.on('exit', (code) => {
      if (!settled) {
        fail(
          new Error(
            `Upload child exited with code ${code}: ${stderr || 'no stderr'}`,
          ),
        );
      }
    });
    uploader.send({
      type: 'upload',
      fixturePath,
      partSizeBytes: VIDEO_UPLOAD.PART_SIZE_BYTES,
      parts,
    });
  });
}

describe('real video pipeline acceptance (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let uploads: Repository<VideoUpload>;
  let jwt: JwtService;
  let storageClient: S3Client;
  let publicStorageClient: S3Client;
  let ownerId: string;
  let channelId: string;
  let videoId: string | undefined;
  let uploadId: string | undefined;
  let objectKey: string | undefined;
  let thumbnailKey: string | null | undefined;
  let token: string;
  const bucket = process.env.S3_BUCKET ?? 'videos';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(S3_PUBLIC_CLIENT)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) => {
          publicStorageClient = new S3Client({
            endpoint: 'http://minio:9000',
            region: config.getOrThrow<string>('S3_REGION'),
            forcePathStyle: true,
            credentials: {
              accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'),
              secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY'),
            },
          });
          return publicStorageClient;
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
    storageClient = moduleFixture.get(S3_CLIENT);
  });

  afterAll(async () => {
    if (thumbnailKey) {
      await storageClient.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: thumbnailKey }),
      );
    }
    if (objectKey) {
      await storageClient.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
    }
    if (videoId) await videos.delete(videoId);
    if (channelId) await channels.delete(channelId);
    if (ownerId) await users.delete(ownerId);
    await app?.close();
    publicStorageClient?.destroy();
  });

  (enabled ? it : it.skip)(
    'uploads and processes exactly 10,000,000,000 bytes with bounded RSS',
    async () => {
      const fixtureDirectory = await mkdtemp(join(tmpdir(), 'video-10gb-'));
      const fixturePath = join(fixtureDirectory, 'source.mp4');
      const initialRss = process.memoryUsage().rss;
      let peakRss = initialRss;

      try {
        await execFile('ffmpeg', [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=64x64:d=1',
          '-an',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-y',
          fixturePath,
        ]);

        const fixture = await open(fixturePath, 'r+');
        try {
          const baseSize = (await fixture.stat()).size;
          const freeBoxSize = LARGE_UPLOAD_BYTES - baseSize;
          const freeBoxHeader = Buffer.alloc(16);
          freeBoxHeader.writeUInt32BE(1, 0);
          freeBoxHeader.write('free', 4, 'ascii');
          freeBoxHeader.writeBigUInt64BE(BigInt(freeBoxSize), 8);
          await fixture.write(freeBoxHeader, 0, freeBoxHeader.length, baseSize);
          await fixture.truncate(LARGE_UPLOAD_BYTES);
        } finally {
          await fixture.close();
        }
        expect((await stat(fixturePath)).size).toBe(LARGE_UPLOAD_BYTES);

        const suffix = randomUUID();
        const owner = await users.save(
          users.create({
            email: `video_10gb_${suffix}@example.com`,
            password: 'test-hash',
            is_confirmed: true,
          }),
        );
        ownerId = owner.id;
        const channel = await channels.save(
          channels.create({
            name: '10 GB acceptance channel',
            nickname: `ten_gb_${suffix.replaceAll('-', '')}`,
            user_id: owner.id,
          }),
        );
        channelId = channel.id;
        token = await jwt.signAsync({ sub: owner.id, email: owner.email });

        const initResponse = await request(app.getHttpServer())
          .post('/videos/uploads')
          .set('Authorization', `Bearer ${token}`)
          .send({ sizeBytes: LARGE_UPLOAD_BYTES, contentType: 'video/mp4' })
          .expect(201);
        videoId = (initResponse.body as { videoId: string }).videoId;
        uploadId = (initResponse.body as { uploadId: string }).uploadId;
        const upload = await uploads.findOneOrFail({
          where: { id: uploadId },
          relations: { video: true },
        });
        objectKey = upload.video.object_key;

        const partCount = Math.ceil(
          LARGE_UPLOAD_BYTES / VIDEO_UPLOAD.PART_SIZE_BYTES,
        );
        const partNumbers = Array.from(
          { length: partCount },
          (_, index) => index + 1,
        );
        const sampleApiRss = () => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        };
        const rssSampler = setInterval(sampleApiRss, 50);
        rssSampler.unref();
        try {
          for (
            let batchStart = 0;
            batchStart < partNumbers.length;
            batchStart += VIDEO_UPLOAD.PART_URL_BATCH_LIMIT
          ) {
            const batch = partNumbers.slice(
              batchStart,
              batchStart + VIDEO_UPLOAD.PART_URL_BATCH_LIMIT,
            );
            const urlResponse = await request(app.getHttpServer())
              .post(`/videos/uploads/${uploadId}/part-urls`)
              .set('Authorization', `Bearer ${token}`)
              .send({ partNumbers: batch })
              .expect(200);
            const signedParts = (
              urlResponse.body as {
                parts: SignedUploadPart[];
              }
            ).parts;
            await uploadPartsInChild(fixturePath, signedParts);
          }
        } finally {
          clearInterval(rssSampler);
          sampleApiRss();
        }

        await request(app.getHttpServer())
          .post(`/videos/uploads/${uploadId}/complete`)
          .set('Authorization', `Bearer ${token}`)
          .expect(202);

        const deadline = Date.now() + 20 * 60 * 1000;
        let video = await videos.findOneByOrFail({ id: videoId });
        while (video.status === 'processing' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          video = await videos.findOneByOrFail({ id: videoId });
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
        expect(video.status).toBe('ready');
        expect(video.size_bytes).toBe(String(LARGE_UPLOAD_BYTES));
        thumbnailKey = video.thumbnail_key;

        const playbackResponse = await request(app.getHttpServer())
          .post(`/videos/${video.public_id}/playback-url`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const playback = playbackResponse.body as { url: string };
        const rangeResponse = await fetch(playback.url, {
          headers: { Range: 'bytes=0-7' },
        });
        expect(rangeResponse.status).toBe(206);
        expect(rangeResponse.headers.get('content-range')).toBe(
          `bytes 0-7/${LARGE_UPLOAD_BYTES}`,
        );
        await rangeResponse.body?.cancel();

        const growthBytes = peakRss - initialRss;
        console.info(
          JSON.stringify({
            acceptance: 'video-10gb',
            bytesUploaded: LARGE_UPLOAD_BYTES,
            partCount,
            finalStatus: video.status,
            apiProcessRssStartBytes: initialRss,
            apiProcessRssPeakBytes: peakRss,
            apiProcessRssGrowthBytes: growthBytes,
          }),
        );
        expect(growthBytes).toBeLessThan(256 * 1024 * 1024);
      } finally {
        if (uploadId && videoId) {
          const upload = await uploads.findOneBy({ id: uploadId });
          if (upload && upload.state !== 'completed') {
            await storageClient.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: objectKey,
                UploadId: upload.upload_id,
              }),
            );
          }
        }
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    },
    25 * 60 * 1000,
  );
});
