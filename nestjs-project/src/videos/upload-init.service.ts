import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChannelsService } from '../channels/channels.service';
import { Video } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import {
  VideoChannelNotFoundException,
  VideoStorageUnavailableException,
  VideoUploadTooLargeException,
} from './video-upload.exceptions';
import {
  MultipartUploadCleanupFailedError,
  S3StorageService,
} from './s3-storage.service';
import { VideosPersistenceService } from './videos.persistence.service';
import { VIDEO_UPLOAD } from './videos.constants';

export interface InitVideoUploadResponse {
  videoId: string;
  publicId: string;
  status: 'draft';
  uploadId: string;
  partSizeBytes: number;
  expiresAt: string;
}

@Injectable()
export class UploadInitService {
  constructor(
    private readonly channels: ChannelsService,
    private readonly persistence: VideosPersistenceService,
    private readonly storage: S3StorageService,
  ) {}

  async start(
    userId: string,
    sizeBytes: number,
    contentType: string,
  ): Promise<InitVideoUploadResponse> {
    if (sizeBytes > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
      throw new VideoUploadTooLargeException();
    }

    const channel = await this.channels.findByUserId(userId);
    if (!channel) throw new VideoChannelNotFoundException();

    const objectKey = `videos/${channel.id}/${randomUUID()}/source`;
    const video: Video = await this.persistence.createDraft(
      channel.id,
      objectKey,
      String(sizeBytes),
    );

    let storageUploadId: string;
    try {
      storageUploadId = await this.storage.createMultipartUpload(
        objectKey,
        contentType,
      );
    } catch (error) {
      if (error instanceof MultipartUploadCleanupFailedError) {
        throw new VideoStorageUnavailableException();
      }
      try {
        await this.deleteDraftWithRetry(video.id);
      } catch {
        throw new VideoStorageUnavailableException();
      }
      throw new VideoStorageUnavailableException();
    }

    const expiresAt = new Date(Date.now() + VIDEO_UPLOAD.EXPIRATION_MS);
    let upload: VideoUpload;
    try {
      upload = await this.persistence.createUploadSession(
        video.id,
        storageUploadId,
        String(sizeBytes),
        String(VIDEO_UPLOAD.PART_SIZE_BYTES),
        expiresAt,
      );
    } catch (error) {
      try {
        await this.abortWithRetry(objectKey, storageUploadId);
      } catch {
        throw new VideoStorageUnavailableException();
      }
      try {
        await this.deleteDraftWithRetry(video.id);
      } catch {
        throw new VideoStorageUnavailableException();
      }
      throw error;
    }

    return {
      videoId: video.id,
      publicId: video.public_id,
      status: 'draft',
      uploadId: upload.id,
      partSizeBytes: VIDEO_UPLOAD.PART_SIZE_BYTES,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async abortWithRetry(key: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch {
      await this.storage.abortMultipartUpload(key, uploadId);
    }
  }

  private async deleteDraftWithRetry(videoId: string): Promise<void> {
    try {
      await this.persistence.deleteDraft(videoId);
    } catch {
      await this.persistence.deleteDraft(videoId);
    }
  }
}
