import { Injectable } from '@nestjs/common';
import type {
  VideoReadUrlResponseDto,
  VideoStateResponseDto,
} from './dto/video-access-response.dto';
import { Video } from './entities/video.entity';
import {
  VideoAccessNotFoundException,
  VideoNotReadyException,
} from './video-access.exceptions';
import { VideoStorageUnavailableException } from './video-upload.exceptions';
import { VideosPersistenceService } from './videos.persistence.service';
import { S3StorageService } from './s3-storage.service';
import { VIDEO_ACCESS } from './videos.constants';

@Injectable()
export class VideoAccessService {
  constructor(
    private readonly persistence: VideosPersistenceService,
    private readonly storage: S3StorageService,
  ) {}

  async getVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoStateResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    return {
      publicId: video.public_id,
      status: video.status,
      sizeBytes: video.size_bytes === null ? null : Number(video.size_bytes),
      durationMs: video.duration_ms === null ? null : Number(video.duration_ms),
      metadata: video.metadata,
      errorCode: video.error_code,
    };
  }

  async createPlaybackUrl(
    userId: string,
    publicId: string,
  ): Promise<VideoReadUrlResponseDto> {
    return this.createReadUrl(userId, publicId, 'inline');
  }

  async createDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<VideoReadUrlResponseDto> {
    return this.createReadUrl(userId, publicId, 'attachment');
  }

  private async createReadUrl(
    userId: string,
    publicId: string,
    disposition: 'inline' | 'attachment',
  ): Promise<VideoReadUrlResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== 'ready') throw new VideoNotReadyException();

    try {
      const issuedAt = Date.now();
      const url = await this.storage.createVideoReadUrl(
        video.object_key,
        disposition,
        disposition === 'attachment'
          ? `video-${video.public_id}.mp4`
          : undefined,
      );
      return {
        url,
        expiresAt: new Date(
          issuedAt + VIDEO_ACCESS.URL_EXPIRATION_SECONDS * 1000,
        ).toISOString(),
      };
    } catch {
      throw new VideoStorageUnavailableException();
    }
  }

  private async findOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.persistence.findVideoForOwner(publicId, userId);
    if (!video) throw new VideoAccessNotFoundException();
    return video;
  }
}
