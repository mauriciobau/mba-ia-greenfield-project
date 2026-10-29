import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class InitVideoUploadDto {
  @ApiProperty({
    description: 'Expected video size in bytes (decimal GB limit)',
    example: 125000000,
    minimum: 1,
    maximum: VIDEO_UPLOAD.MAX_SIZE_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes: number;

  @ApiProperty({ enum: [VIDEO_UPLOAD.CONTENT_TYPE] })
  @IsString()
  @IsIn([VIDEO_UPLOAD.CONTENT_TYPE])
  contentType: string;
}
