import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';

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
