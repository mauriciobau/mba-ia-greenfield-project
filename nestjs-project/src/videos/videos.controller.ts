import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { InitVideoUploadDto } from './dto/init-video-upload.dto';
import { UploadInitService } from './upload-init.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly uploadInit: UploadInitService) {}

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
}
