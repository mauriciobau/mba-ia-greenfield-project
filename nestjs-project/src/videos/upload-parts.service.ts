import { Injectable } from '@nestjs/common';
import { VideoUpload } from './entities/video-upload.entity';
import {
  VideoStorageUnavailableException,
  VideoUploadConflictException,
  VideoUploadInvalidPartsException,
  VideoUploadNotFoundException,
} from './video-upload.exceptions';
import { S3StorageService } from './s3-storage.service';
import { VIDEO_UPLOAD } from './videos.constants';
import { VideosPersistenceService } from './videos.persistence.service';

export interface UploadPartsResponse {
  state: VideoUpload['state'];
  expectedSizeBytes: number;
  partSizeBytes: number;
  expiresAt: string;
  parts: { partNumber: number; size: number; etag: string }[];
  nextCursor: number | null;
}

@Injectable()
export class UploadPartsService {
  constructor(
    private readonly persistence: VideosPersistenceService,
    private readonly storage: S3StorageService,
  ) {}

  async list(
    userId: string,
    uploadId: string,
    cursor?: number,
  ): Promise<UploadPartsResponse> {
    const upload = await this.getActiveOwnedUpload(userId, uploadId);
    try {
      const page = await this.storage.listParts(
        upload.video.object_key,
        upload.upload_id,
        cursor,
      );
      return {
        state: upload.state,
        expectedSizeBytes: Number(upload.expected_size_bytes),
        partSizeBytes: Number(upload.part_size_bytes),
        expiresAt: upload.expires_at.toISOString(),
        parts: page.parts,
        nextCursor: page.nextCursor,
      };
    } catch {
      throw new VideoStorageUnavailableException();
    }
  }

  async createPartUrls(
    userId: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{
    parts: { partNumber: number; url: string; expiresAt: string }[];
  }> {
    const upload = await this.getActiveOwnedUpload(userId, uploadId);
    const maxPartNumber = Math.min(
      VIDEO_UPLOAD.MAX_PARTS,
      Math.ceil(
        Number(upload.expected_size_bytes) / Number(upload.part_size_bytes),
      ),
    );
    if (
      partNumbers.length === 0 ||
      partNumbers.length > VIDEO_UPLOAD.PART_URL_BATCH_LIMIT ||
      new Set(partNumbers).size !== partNumbers.length ||
      partNumbers.some(
        (partNumber) =>
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > maxPartNumber,
      )
    ) {
      throw new VideoUploadInvalidPartsException();
    }

    try {
      const expiresAt = new Date(
        Date.now() + VIDEO_UPLOAD.PART_URL_EXPIRATION_SECONDS * 1000,
      ).toISOString();
      const parts = await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await this.storage.createPartUrl(
            upload.video.object_key,
            upload.upload_id,
            partNumber,
          ),
          expiresAt,
        })),
      );
      return { parts };
    } catch {
      throw new VideoStorageUnavailableException();
    }
  }

  private async getActiveOwnedUpload(
    userId: string,
    uploadId: string,
  ): Promise<VideoUpload> {
    const upload = await this.persistence.findUploadForOwner(uploadId, userId);
    if (!upload) throw new VideoUploadNotFoundException();
    if (
      upload.state !== 'initiated' ||
      upload.expires_at.getTime() <= Date.now()
    ) {
      throw new VideoUploadConflictException();
    }
    return upload;
  }
}
