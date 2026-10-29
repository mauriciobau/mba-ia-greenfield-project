import { Injectable } from '@nestjs/common';
import { VideoStatus } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import {
  VideoStorageUnavailableException,
  VideoUploadConflictException,
  VideoUploadInvalidPartsException,
  VideoUploadNotFoundException,
  VideoUploadTooLargeException,
} from './video-upload.exceptions';
import { S3StorageService, UploadedPart } from './s3-storage.service';
import { VIDEO_UPLOAD } from './videos.constants';
import { VideosPersistenceService } from './videos.persistence.service';

const MINIMUM_NON_FINAL_PART_BYTES = 5 * 1024 * 1024;

export interface CompleteUploadResponse {
  videoId: string;
  status: VideoStatus;
}

@Injectable()
export class UploadCompletionService {
  constructor(
    private readonly persistence: VideosPersistenceService,
    private readonly storage: S3StorageService,
  ) {}

  async complete(
    userId: string,
    uploadId: string,
  ): Promise<CompleteUploadResponse> {
    const upload = await this.findOwnedUpload(userId, uploadId);
    if (upload.state === 'completed') {
      return { videoId: upload.video_id, status: upload.video.status };
    }
    if (upload.state === 'aborted') throw new VideoUploadConflictException();
    if (
      upload.state === 'initiated' &&
      upload.expires_at.getTime() <= Date.now()
    ) {
      throw new VideoUploadConflictException();
    }

    let completionHeartbeat: NodeJS.Timeout | undefined;
    let leaseLost = false;
    try {
      const completionToken = await this.persistence.claimUploadCompletion(
        upload.id,
      );
      if (!completionToken) {
        throw new VideoUploadConflictException();
      }
      const leaseToken = completionToken;
      completionHeartbeat = setInterval(() => {
        void this.persistence
          .renewUploadCompletion(upload.id, leaseToken)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          });
      }, VIDEO_UPLOAD.COMPLETION_HEARTBEAT_MS);
      completionHeartbeat.unref();

      let actualSize = await this.storage.getObjectSize(
        upload.video.object_key,
      );
      if (actualSize === null) {
        let parts: UploadedPart[];
        try {
          parts = await this.getAllParts(upload);
          this.validateParts(upload, parts);
        } catch (error) {
          if (
            error instanceof VideoUploadInvalidPartsException ||
            error instanceof VideoUploadTooLargeException
          ) {
            await this.resetCompletionOrThrow(upload.id, leaseToken);
          }
          throw error;
        }
        if (
          leaseLost ||
          !(await this.persistence.renewUploadCompletion(upload.id, leaseToken))
        ) {
          leaseLost = true;
          throw new VideoStorageUnavailableException();
        }
        try {
          await this.storage.completeMultipartUpload(
            upload.video.object_key,
            upload.upload_id,
            parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
          );
        } catch (error) {
          // A timeout can hide a successful completion. HeadObject makes the
          // next step safe to retry without replaying or losing the draft.
          actualSize = await this.storage.getObjectSize(
            upload.video.object_key,
          );
          if (actualSize === null) {
            if (this.isInvalidPartError(error)) {
              await this.resetCompletionOrThrow(upload.id, leaseToken);
              throw new VideoUploadInvalidPartsException();
            }
            throw error;
          }
        }
        if (actualSize === null) {
          actualSize = await this.storage.getObjectSize(
            upload.video.object_key,
          );
        }
        if (actualSize === null) {
          throw new VideoStorageUnavailableException();
        }
      }

      if (
        actualSize > VIDEO_UPLOAD.MAX_SIZE_BYTES ||
        actualSize !== Number(upload.expected_size_bytes)
      ) {
        if (
          !(await this.persistence.rejectCompletedUpload(upload.id, leaseToken))
        ) {
          throw new VideoUploadConflictException();
        }
        await this.cleanupAbortedStorage(upload);
        if (actualSize > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
          throw new VideoUploadTooLargeException();
        }
        throw new VideoUploadInvalidPartsException();
      }

      if (leaseLost) throw new VideoStorageUnavailableException();
      const result = await this.persistence.finishUpload(
        upload.id,
        upload.video_id,
        String(actualSize),
        leaseToken,
      );
      if (result === 'conflict') throw new VideoUploadConflictException();
      return { videoId: upload.video_id, status: 'processing' };
    } catch (error) {
      if (
        error instanceof VideoUploadConflictException ||
        error instanceof VideoUploadInvalidPartsException ||
        error instanceof VideoUploadTooLargeException ||
        error instanceof VideoStorageUnavailableException
      ) {
        throw error;
      }
      throw new VideoStorageUnavailableException();
    } finally {
      if (completionHeartbeat) clearInterval(completionHeartbeat);
    }
  }

  async abort(userId: string, uploadId: string): Promise<void> {
    const upload = await this.findOwnedUpload(userId, uploadId);
    if (upload.state === 'completed' || upload.state === 'completing') {
      throw new VideoUploadConflictException();
    }
    if (!(await this.persistence.abortUpload(upload.id))) {
      throw new VideoUploadConflictException();
    }

    await this.cleanupAbortedStorage(upload);
  }

  private async findOwnedUpload(
    userId: string,
    uploadId: string,
  ): Promise<VideoUpload> {
    const upload = await this.persistence.findUploadForOwner(uploadId, userId);
    if (!upload) throw new VideoUploadNotFoundException();
    return upload;
  }

  private async getAllParts(upload: VideoUpload): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let cursor: number | undefined;
    do {
      const page = await this.storage.listParts(
        upload.video.object_key,
        upload.upload_id,
        cursor,
      );
      parts.push(...page.parts);
      if (parts.length > VIDEO_UPLOAD.MAX_PARTS) {
        throw new VideoUploadInvalidPartsException();
      }
      if (
        page.nextCursor !== null &&
        (!Number.isInteger(page.nextCursor) ||
          (cursor !== undefined && page.nextCursor <= cursor) ||
          (page.parts.length > 0 &&
            page.nextCursor <= page.parts[page.parts.length - 1].partNumber))
      ) {
        throw new VideoUploadInvalidPartsException();
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return parts;
  }

  private validateParts(upload: VideoUpload, parts: UploadedPart[]): number {
    if (parts.length === 0 || parts.length > VIDEO_UPLOAD.MAX_PARTS) {
      throw new VideoUploadInvalidPartsException();
    }

    let totalSize = 0;
    for (const [index, part] of parts.entries()) {
      if (
        part.partNumber !== index + 1 ||
        !Number.isSafeInteger(part.size) ||
        part.size <= 0 ||
        !part.etag
      ) {
        throw new VideoUploadInvalidPartsException();
      }
      if (
        index < parts.length - 1 &&
        part.size < MINIMUM_NON_FINAL_PART_BYTES
      ) {
        throw new VideoUploadInvalidPartsException();
      }
      totalSize += part.size;
      if (totalSize > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
        throw new VideoUploadTooLargeException();
      }
    }

    if (totalSize !== Number(upload.expected_size_bytes)) {
      throw new VideoUploadInvalidPartsException();
    }
    return totalSize;
  }

  private isInvalidPartError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('name' in error)) {
      return false;
    }
    return ['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'].includes(
      String(error.name),
    );
  }

  private async resetCompletionOrThrow(
    uploadId: string,
    completionToken: string,
  ): Promise<void> {
    if (
      !(await this.persistence.resetUploadCompletion(uploadId, completionToken))
    ) {
      throw new VideoUploadConflictException();
    }
  }

  async cleanupAbortedStorage(upload: VideoUpload): Promise<void> {
    const results = await Promise.allSettled([
      this.storage.abortMultipartUpload(
        upload.video.object_key,
        upload.upload_id,
      ),
      this.storage.deleteObject(upload.video.object_key),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new VideoStorageUnavailableException();
    }
  }
}
