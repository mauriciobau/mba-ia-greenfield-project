import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, MoreThan } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VIDEO_UPLOAD } from './videos.constants';
import { VIDEO_PROCESSING_MAX_RECOVERIES } from './video-queue.constants';

const PUBLIC_ID_ATTEMPTS = 5;

@Injectable()
export class VideosPersistenceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async createDraft(
    channelId: string,
    objectKey: string,
    sizeBytes: string,
  ): Promise<Video> {
    return this.dataSource.transaction(async (manager) => {
      for (let attempt = 0; attempt < PUBLIC_ID_ATTEMPTS; attempt += 1) {
        const savepoint = `public_id_attempt_${attempt}`;
        await manager.query(`SAVEPOINT ${savepoint}`);

        try {
          const video = manager.create(Video, {
            channel_id: channelId,
            public_id: this.generatePublicId(),
            object_key: objectKey,
            size_bytes: sizeBytes,
            status: 'draft',
          });
          const savedVideo = await manager.save(Video, video);
          await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
          return savedVideo;
        } catch (error) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          if (
            !this.isPublicIdCollision(error) ||
            attempt === PUBLIC_ID_ATTEMPTS - 1
          ) {
            throw error;
          }
        }
      }

      throw new Error('Video public_id generation exhausted without an error');
    });
  }

  async createUploadSession(
    videoId: string,
    storageUploadId: string,
    expectedSizeBytes: string,
    partSizeBytes: string,
    expiresAt: Date,
  ): Promise<VideoUpload> {
    return this.dataSource.transaction(async (manager) => {
      const video = await manager.findOne(Video, {
        where: { id: videoId, status: 'draft' },
      });
      if (!video) {
        throw new Error(
          'Draft video disappeared before upload session creation',
        );
      }

      const upload = manager.create(VideoUpload, {
        video_id: videoId,
        upload_id: storageUploadId,
        expected_size_bytes: expectedSizeBytes,
        part_size_bytes: partSizeBytes,
        expires_at: expiresAt,
        state: 'initiated',
      });
      return manager.save(VideoUpload, upload);
    });
  }

  async findUploadForOwner(
    uploadId: string,
    userId: string,
  ): Promise<VideoUpload | null> {
    return this.dataSource
      .getRepository(VideoUpload)
      .createQueryBuilder('upload')
      .innerJoinAndSelect('upload.video', 'video')
      .innerJoin('video.channel', 'channel')
      .where('upload.id = :uploadId', { uploadId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
  }

  async findVideoForOwner(
    publicId: string,
    userId: string,
  ): Promise<Video | null> {
    return this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel')
      .where('video.public_id = :publicId', { publicId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
  }

  async findUploadSessionsToReconcile(now: Date): Promise<VideoUpload[]> {
    return this.dataSource
      .getRepository(VideoUpload)
      .createQueryBuilder('upload')
      .innerJoinAndSelect('upload.video', 'video')
      .innerJoinAndSelect('video.channel', 'channel')
      .where(
        `(upload.state = :completing AND upload.updated_at <= :completionStaleBefore) OR upload.state = :aborted OR (upload.state = :initiated AND upload.expires_at <= :now)`,
        {
          completing: 'completing',
          aborted: 'aborted',
          initiated: 'initiated',
          completionStaleBefore: new Date(
            now.getTime() - VIDEO_UPLOAD.COMPLETION_LEASE_MS,
          ),
          now,
        },
      )
      .orderBy('upload.updated_at', 'ASC')
      .take(100)
      .getMany();
  }

  async findOrphanDrafts(cutoff: Date, limit = 100): Promise<Video[]> {
    return this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .leftJoin('video.upload', 'upload')
      .where('video.status = :status', { status: 'draft' })
      .andWhere('upload.id IS NULL')
      .andWhere('video.created_at <= :cutoff', { cutoff })
      .orderBy('video.updated_at', 'ASC')
      .take(limit)
      .getMany();
  }

  async deleteOrphanDraft(videoId: string, cutoff: Date): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(Video)
      .where(
        `id = :videoId AND status = :status AND created_at <= :cutoff AND NOT EXISTS (SELECT 1 FROM video_uploads upload WHERE upload.video_id = "videos"."id")`,
        { videoId, status: 'draft', cutoff },
      )
      .execute();
  }

  async touchUploadReconciliation(uploadId: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ updated_at: new Date() })
      .where('id = :uploadId AND state = :state', {
        uploadId,
        state: 'aborted',
      })
      .execute();
  }

  async touchOrphanDraftReconciliation(videoId: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(Video)
      .set({ updated_at: new Date() })
      .where('id = :videoId AND status = :status', {
        videoId,
        status: 'draft',
      })
      .execute();
  }

  async deleteDraft(videoId: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(Video)
      .where('id = :videoId AND status = :status', {
        videoId,
        status: 'draft',
      })
      .execute();
  }

  async startProcessing(videoId: string, generation: number): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const transition = await manager
        .createQueryBuilder()
        .update(Video)
        .set({ status: 'processing' })
        .where('id = :videoId AND status = :expectedStatus', {
          videoId,
          expectedStatus: 'draft',
        })
        .execute();

      if (transition.affected !== 1) {
        return false;
      }

      const outboxEvent = manager.create(VideoProcessingOutbox, {
        video_id: videoId,
        generation,
        state: 'pending',
      });
      await manager.save(VideoProcessingOutbox, outboxEvent);
      return true;
    });
  }

  async claimProcessingExecution(
    eventId: string,
    videoId: string,
    generation: number,
    executionToken: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const claim = await this.dataSource
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({
        state: 'published',
        execution_token: executionToken,
        lease_expires_at: leaseExpiresAt,
      })
      .where(
        'id = :eventId AND video_id = :videoId AND generation = :generation',
        { eventId, videoId, generation },
      )
      .andWhere('state IN (:...states)', {
        states: ['pending', 'published'],
      })
      .andWhere('(execution_token IS NULL OR lease_expires_at <= NOW())')
      .andWhere(
        `EXISTS (SELECT 1 FROM videos WHERE videos.id = :videoId AND videos.status = 'processing')`,
      )
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM video_processing_outbox newer WHERE newer.video_id = :videoId AND newer.generation > :generation)`,
      )
      .execute();
    return claim.affected === 1;
  }

  async renewProcessingExecution(
    eventId: string,
    videoId: string,
    generation: number,
    executionToken: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const renewed = await this.dataSource
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({ lease_expires_at: leaseExpiresAt })
      .where(
        'id = :eventId AND video_id = :videoId AND generation = :generation AND execution_token = :executionToken',
        { eventId, videoId, generation, executionToken },
      )
      .andWhere('lease_expires_at > NOW()')
      .execute();
    return renewed.affected === 1;
  }

  async releaseProcessingExecution(
    eventId: string,
    videoId: string,
    generation: number,
    executionToken: string,
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({ execution_token: null, lease_expires_at: null })
      .where(
        'id = :eventId AND video_id = :videoId AND generation = :generation AND execution_token = :executionToken',
        { eventId, videoId, generation, executionToken },
      )
      .execute();
  }

  async markVideoReady(
    eventId: string,
    videoId: string,
    generation: number,
    executionToken: string,
    values: {
      thumbnail_key: string;
      duration_ms: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const transition = await this.dataSource
      .createQueryBuilder()
      .update(Video)
      .set({
        status: 'ready',
        thumbnail_key: values.thumbnail_key,
        duration_ms: values.duration_ms,
        metadata: values.metadata,
        error_code: null,
      })
      .where('id = :videoId AND status = :status', {
        videoId,
        status: 'processing',
      })
      .andWhere(
        `EXISTS (SELECT 1 FROM video_processing_outbox event WHERE event.id = :eventId AND event.video_id = :videoId AND event.generation = :generation AND event.execution_token = :executionToken AND event.lease_expires_at > NOW())`,
        { eventId, videoId, generation, executionToken },
      )
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM video_processing_outbox newer WHERE newer.video_id = :videoId AND newer.generation > :generation)`,
      )
      .execute();
    return transition.affected === 1;
  }

  async markVideoError(
    eventId: string,
    videoId: string,
    generation: number,
    executionToken: string,
    errorCode: string,
  ): Promise<boolean> {
    const transition = await this.dataSource
      .createQueryBuilder()
      .update(Video)
      .set({ status: 'error', error_code: errorCode })
      .where('id = :videoId AND status = :status', {
        videoId,
        status: 'processing',
      })
      .andWhere(
        `EXISTS (SELECT 1 FROM video_processing_outbox event WHERE event.id = :eventId AND event.video_id = :videoId AND event.generation = :generation AND event.execution_token = :executionToken AND event.lease_expires_at > NOW())`,
        { eventId, videoId, generation, executionToken },
      )
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM video_processing_outbox newer WHERE newer.video_id = :videoId AND newer.generation > :generation)`,
      )
      .execute();
    return transition.affected === 1;
  }

  async recoverFailedProcessingJob(
    eventId: string,
    staleBefore: Date,
  ): Promise<'retry' | 'exhausted' | 'recent' | 'stale'> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(VideoProcessingOutbox, {
        where: { id: eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event || !['pending', 'published'].includes(event.state))
        return 'stale';
      if (event.updated_at > staleBefore) return 'recent';
      const newerGeneration = await manager.findOne(VideoProcessingOutbox, {
        where: {
          video_id: event.video_id,
          generation: MoreThan(event.generation),
        },
      });
      if (newerGeneration) return 'stale';

      const video = await manager.findOne(Video, {
        where: { id: event.video_id, status: 'processing' },
      });
      if (!video) return 'stale';
      if (event.lease_expires_at && event.lease_expires_at > new Date()) {
        await manager.save(VideoProcessingOutbox, event);
        return 'recent';
      }

      if (event.recovery_count >= VIDEO_PROCESSING_MAX_RECOVERIES) {
        const failed = await manager
          .createQueryBuilder()
          .update(Video)
          .set({ status: 'error', error_code: 'VIDEO_PROCESSING_FAILED' })
          .where('id = :videoId AND status = :status', {
            videoId: video.id,
            status: 'processing',
          })
          .andWhere(
            `EXISTS (SELECT 1 FROM video_processing_outbox event WHERE event.id = :eventId AND event.video_id = :videoId AND event.generation = :generation)`,
            { eventId, videoId: video.id, generation: event.generation },
          )
          .andWhere(
            `NOT EXISTS (SELECT 1 FROM video_processing_outbox newer WHERE newer.video_id = :videoId AND newer.generation > :generation)`,
          )
          .execute();
        if (failed.affected === 1) return 'exhausted';
        return 'stale';
      }

      event.recovery_count += 1;
      event.state = 'published';
      await manager.save(VideoProcessingOutbox, event);
      return 'retry';
    });
  }

  async claimUploadCompletion(uploadId: string): Promise<string | null> {
    const staleBefore = new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS);
    const completionToken = randomUUID();
    const claimed = await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ state: 'completing', completion_token: completionToken })
      .where(
        `id = :uploadId AND (state = :initiated OR (state = :completing AND updated_at <= :staleBefore))`,
        {
          uploadId,
          initiated: 'initiated',
          completing: 'completing',
          staleBefore,
        },
      )
      .execute();
    return claimed.affected === 1 ? completionToken : null;
  }

  async renewUploadCompletion(
    uploadId: string,
    completionToken: string,
  ): Promise<boolean> {
    const renewed = await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ state: 'completing' })
      .where(
        'id = :uploadId AND state = :state AND completion_token = :completionToken',
        { uploadId, state: 'completing', completionToken },
      )
      .execute();
    return renewed.affected === 1;
  }

  async resetUploadCompletion(
    uploadId: string,
    completionToken: string,
  ): Promise<boolean> {
    const reset = await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ state: 'initiated', completion_token: null })
      .where(
        'id = :uploadId AND state = :expectedState AND completion_token = :completionToken',
        { uploadId, expectedState: 'completing', completionToken },
      )
      .execute();
    return reset.affected === 1;
  }

  async abortUpload(uploadId: string): Promise<boolean> {
    const aborted = await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ state: 'aborted', completion_token: null })
      .where('id = :uploadId AND state = :expectedState', {
        uploadId,
        expectedState: 'initiated',
      })
      .execute();
    if (aborted.affected === 1) return true;

    const current = await this.dataSource
      .getRepository(VideoUpload)
      .findOneBy({ id: uploadId });
    return current?.state === 'aborted';
  }

  async rejectCompletedUpload(
    uploadId: string,
    completionToken: string,
  ): Promise<boolean> {
    const rejected = await this.dataSource
      .createQueryBuilder()
      .update(VideoUpload)
      .set({ state: 'aborted', completion_token: null })
      .where(
        'id = :uploadId AND state = :expectedState AND completion_token = :completionToken',
        { uploadId, expectedState: 'completing', completionToken },
      )
      .execute();
    return rejected.affected === 1;
  }

  async finishUpload(
    uploadId: string,
    videoId: string,
    actualSizeBytes: string,
    completionToken: string,
  ): Promise<'completed' | 'already-completed' | 'conflict'> {
    return this.dataSource.transaction(async (manager) => {
      const upload = await manager.findOne(VideoUpload, {
        where: { id: uploadId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!upload || upload.video_id !== videoId) return 'conflict';
      if (upload.state === 'completed') return 'already-completed';
      if (
        upload.state !== 'completing' ||
        upload.completion_token !== completionToken
      ) {
        return 'conflict';
      }

      const transition = await manager
        .createQueryBuilder()
        .update(Video)
        .set({ status: 'processing', size_bytes: actualSizeBytes })
        .where('id = :videoId AND status = :expectedStatus', {
          videoId,
          expectedStatus: 'draft',
        })
        .execute();
      if (transition.affected !== 1) return 'conflict';

      upload.state = 'completed';
      upload.completion_token = null;
      await manager.save(VideoUpload, upload);
      await manager.save(
        VideoProcessingOutbox,
        manager.create(VideoProcessingOutbox, {
          video_id: videoId,
          generation: 1,
          state: 'pending',
        }),
      );
      return 'completed';
    });
  }

  generatePublicId(): string {
    return randomBytes(9).toString('base64url');
  }

  private isPublicIdCollision(error: unknown): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('driverError' in error)
    ) {
      return false;
    }

    const driverError = error.driverError;
    return (
      typeof driverError === 'object' &&
      driverError !== null &&
      'constraint' in driverError &&
      driverError.constraint === 'UQ_videos_public_id'
    );
  }
}
