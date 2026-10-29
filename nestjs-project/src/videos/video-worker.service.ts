import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideosPersistenceService } from './videos.persistence.service';
import { ProbeResult, validateVideoProbe } from './video-probe';
import { S3StorageService } from './s3-storage.service';
import {
  VIDEO_PROCESSING_EXECUTION_HEARTBEAT_MS,
  VIDEO_PROCESSING_EXECUTION_LEASE_MS,
  VIDEO_PROCESSING_TIMEOUT_MS,
  VideoProcessingJobData,
} from './video-queue.constants';

const execFile = promisify(execFileCallback);
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

@Injectable()
export class VideoWorkerService {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  private readonly ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: S3StorageService,
    private readonly persistence: VideosPersistenceService,
  ) {}

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    let lockHeld = false;
    let executionToken: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatRunning = false;
    const lockKey = `${job.data.videoId}:${job.data.generation}`;
    const controller = new AbortController();
    try {
      const result = (await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      )) as Array<{ locked: boolean }>;
      lockHeld = result[0]?.locked === true;
      if (!lockHeld) return;
      executionToken = randomUUID();
      const claimed = await this.persistence.claimProcessingExecution(
        job.data.eventId,
        job.data.videoId,
        job.data.generation,
        executionToken,
        new Date(Date.now() + VIDEO_PROCESSING_EXECUTION_LEASE_MS),
      );
      if (!claimed) return;
      heartbeat = setInterval(() => {
        if (heartbeatRunning || controller.signal.aborted || !executionToken)
          return;
        heartbeatRunning = true;
        void this.persistence
          .renewProcessingExecution(
            job.data.eventId,
            job.data.videoId,
            job.data.generation,
            executionToken,
            new Date(Date.now() + VIDEO_PROCESSING_EXECUTION_LEASE_MS),
          )
          .then((renewed) => {
            if (!renewed)
              controller.abort(new Error('Execution lease was lost'));
          })
          .catch((error: unknown) => controller.abort(error))
          .finally(() => {
            heartbeatRunning = false;
          });
      }, VIDEO_PROCESSING_EXECUTION_HEARTBEAT_MS);
      heartbeat.unref();
      await this.processWithLease(job, executionToken, controller.signal);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try {
        if (executionToken) {
          await this.persistence.releaseProcessingExecution(
            job.data.eventId,
            job.data.videoId,
            job.data.generation,
            executionToken,
          );
        }
      } finally {
        try {
          if (lockHeld) {
            await queryRunner.query(
              'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
              [lockKey],
            );
          }
        } finally {
          await queryRunner.release();
        }
      }
    }
  }

  private async processWithLease(
    job: Job<VideoProcessingJobData>,
    executionToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { videoId, generation } = job.data;
    const video = await this.dataSource.getRepository(Video).findOneBy({
      id: videoId,
    });
    if (!video || video.status !== 'processing') return;
    if (!(await this.isCurrentGeneration(videoId, generation))) return;

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
    const sourcePath = join(workDir, 'source.mp4');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');
    const thumbnailKey = `videos/${videoId}/generation-${generation}/attempt-${executionToken}.jpg`;
    let thumbnailUploaded = false;
    try {
      const downloadSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(VIDEO_PROCESSING_TIMEOUT_MS),
      ]);
      const size = await this.storage.downloadObjectToFile(
        video.object_key,
        sourcePath,
        downloadSignal,
      );
      if (String(size) !== video.size_bytes) {
        throw new UnrecoverableError(
          'Uploaded video size differs from its record',
        );
      }

      const probe = await this.probe(sourcePath, signal);
      const media = validateVideoProbe(probe, size);
      const seekSeconds = Math.min(1, media.durationSeconds / 10);
      await execFile(
        this.ffmpeg,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-ss',
          String(seekSeconds),
          '-i',
          sourcePath,
          '-frames:v',
          '1',
          '-vf',
          "scale=w='min(640,iw)':h=-2",
          '-q:v',
          '4',
          '-y',
          thumbnailPath,
        ],
        {
          timeout: VIDEO_PROCESSING_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          signal,
        },
      );
      const thumbnailStats = await stat(thumbnailPath);
      if (
        thumbnailStats.size === 0 ||
        thumbnailStats.size > MAX_THUMBNAIL_BYTES
      ) {
        throw new UnrecoverableError('FFmpeg produced an invalid thumbnail');
      }

      await this.storage.uploadThumbnail(
        thumbnailKey,
        thumbnailPath,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(VIDEO_PROCESSING_TIMEOUT_MS),
        ]),
      );
      thumbnailUploaded = true;
      const ready = await this.persistence.markVideoReady(
        job.data.eventId,
        videoId,
        generation,
        executionToken,
        {
          thumbnail_key: thumbnailKey,
          duration_ms: String(Math.round(media.durationSeconds * 1000)),
          metadata: media.metadata,
        },
      );
      if (!ready) {
        await this.storage.deleteObject(thumbnailKey);
      }
    } catch (error) {
      if (thumbnailUploaded) await this.storage.deleteObject(thumbnailKey);
      const finalAttempt =
        job.attemptsMade >= (job.opts.attempts ?? 1) - 1 ||
        error instanceof UnrecoverableError;
      if (finalAttempt) {
        await this.persistence.markVideoError(
          job.data.eventId,
          videoId,
          generation,
          executionToken,
          this.errorCode(error),
        );
        if (!(error instanceof UnrecoverableError)) {
          throw new UnrecoverableError(this.errorMessage(error));
        }
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async probe(path: string, signal: AbortSignal): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFile(
        this.ffprobe,
        [
          '-v',
          'error',
          '-show_entries',
          'format=format_name,duration,size:stream=codec_type,codec_name,width,height',
          '-of',
          'json',
          path,
        ],
        {
          timeout: VIDEO_PROCESSING_TIMEOUT_MS,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          signal,
        },
      ));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UnrecoverableError('ffprobe could not inspect uploaded media');
    }
    try {
      return JSON.parse(stdout) as ProbeResult;
    } catch {
      throw new UnrecoverableError('ffprobe returned invalid media metadata');
    }
  }

  private async isCurrentGeneration(
    videoId: string,
    generation: number,
  ): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .innerJoin(
        'video.processing_events',
        'event',
        'event.generation = :generation',
        {
          generation,
        },
      )
      .leftJoin(
        'video.processing_events',
        'newer',
        'newer.generation > :generation',
        { generation },
      )
      .where('video.id = :videoId AND video.status = :status', {
        videoId,
        status: 'processing',
      })
      .andWhere('newer.id IS NULL')
      .getCount();
    return count === 1;
  }

  private errorCode(error: unknown): string {
    if (error instanceof UnrecoverableError) return 'VIDEO_INVALID_MEDIA';
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ETIMEDOUT'
    ) {
      return 'VIDEO_PROCESSING_TIMEOUT';
    }
    return 'VIDEO_PROCESSING_FAILED';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
