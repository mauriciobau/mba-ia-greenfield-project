import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { InitVideoUploadDto } from './dto/init-video-upload.dto';
import { UploadInitService } from './upload-init.service';
import { CreatePartUrlsDto } from './dto/create-part-urls.dto';
import { ListUploadPartsQueryDto } from './dto/list-upload-parts-query.dto';
import { UploadPartsService } from './upload-parts.service';
import { UploadCompletionService } from './upload-completion.service';
import { VideoAccessService } from './video-access.service';
import {
  VideoReadUrlResponseDto,
  VideoStateResponseDto,
} from './dto/video-access-response.dto';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploadInit: UploadInitService,
    private readonly uploadParts: UploadPartsService,
    private readonly uploadCompletion: UploadCompletionService,
    private readonly videoAccess: VideoAccessService,
  ) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Create a video draft and start a multipart upload',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        videoId: '9a9bb1fc-3744-4ae6-bf8a-ec36b48c70b7',
        publicId: 'r4nd0mP4yL0ad',
        status: 'draft',
        uploadId: 'de953e26-82ab-4cf0-8131-5cbd60b9bf38',
        partSizeBytes: 67108864,
        expiresAt: '2026-10-29T00:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 413, description: 'VIDEO_UPLOAD_TOO_LARGE' })
  @ApiResponse({ status: 503, description: 'VIDEO_STORAGE_UNAVAILABLE' })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitVideoUploadDto,
  ) {
    return this.uploadInit.start(user.sub, dto.sizeBytes, dto.contentType);
  }

  @Get('uploads/:uploadId')
  @ApiOperation({
    summary: 'List uploaded parts and resume a multipart video upload',
  })
  @ApiOkResponse({
    schema: {
      example: {
        state: 'initiated',
        expectedSizeBytes: 1024,
        partSizeBytes: 67108864,
        expiresAt: '2026-10-29T00:00:00.000Z',
        parts: [{ partNumber: 1, size: 1024, etag: '"etag-value"' }],
        nextCursor: null,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_CONFLICT',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
    @Query() query: ListUploadPartsQueryDto,
  ) {
    return this.uploadParts.list(user.sub, uploadId, query.cursor);
  }

  @Post('uploads/:uploadId/part-urls')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create temporary upload URLs for parts of an active session',
  })
  @ApiOkResponse({
    schema: {
      example: {
        parts: [
          {
            partNumber: 1,
            url: 'http://localhost:9000/videos/videos/key?X-Amz-Signature=...',
            expiresAt: '2026-10-28T12:05:00.000Z',
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_UPLOAD_INVALID_PARTS or validation error',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_CONFLICT',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
    @Body() dto: CreatePartUrlsDto,
  ) {
    return this.uploadParts.createPartUrls(user.sub, uploadId, dto.partNumbers);
  }

  @Post('uploads/:uploadId/complete')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Complete a multipart upload and queue video processing',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and processing recorded',
    schema: {
      example: {
        videoId: '9a9bb1fc-3744-4ae6-bf8a-ec36b48c70b7',
        status: 'processing',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_UPLOAD_INVALID_PARTS',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_CONFLICT',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_UPLOAD_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
  ) {
    return this.uploadCompletion.complete(user.sub, uploadId);
  }

  @Delete('uploads/:uploadId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Abort a multipart upload and remove its temporary parts',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted or already aborted',
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_CONFLICT',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('uploadId') uploadId: string,
  ): Promise<void> {
    await this.uploadCompletion.abort(user.sub, uploadId);
  }

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get the processing status and metadata of an owned video',
  })
  @ApiOkResponse({ type: VideoStateResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ) {
    return this.videoAccess.getVideo(user.sub, publicId);
  }

  @Post(':publicId/playback-url')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a temporary streaming URL for an owned ready video',
    description:
      'The URL supports HTTP Range requests and expires after five minutes. Call again to renew it.',
  })
  @ApiOkResponse({ type: VideoReadUrlResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ) {
    return this.videoAccess.createPlaybackUrl(user.sub, publicId);
  }

  @Post(':publicId/download-url')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a temporary download URL for an owned ready video',
    description:
      'The storage response uses Content-Disposition attachment and the URL expires after five minutes.',
  })
  @ApiOkResponse({ type: VideoReadUrlResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ) {
    return this.videoAccess.createDownloadUrl(user.sub, publicId);
  }
}
