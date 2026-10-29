import { ApiProperty } from '@nestjs/swagger';
import type { VideoStatus } from '../entities/video.entity';

export class VideoStateResponseDto {
  @ApiProperty({ example: 'r4nd0mP4yL0ad' })
  publicId: string;

  @ApiProperty({
    enum: ['draft', 'processing', 'ready', 'error'],
    example: 'ready',
  })
  status: VideoStatus;

  @ApiProperty({ type: 'integer', nullable: true, example: 1024 })
  sizeBytes: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 15000 })
  durationMs: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { videoCodec: 'h264', audioCodec: 'aac' },
  })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  errorCode: string | null;
}

export class VideoReadUrlResponseDto {
  @ApiProperty({
    format: 'uri',
    example: 'http://minio:9000/videos/videos/key?X-Amz-Signature=...',
  })
  url: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-29T00:05:00.000Z',
  })
  expiresAt: string;
}
