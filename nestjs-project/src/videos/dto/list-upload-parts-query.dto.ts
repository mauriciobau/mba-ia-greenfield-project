import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class ListUploadPartsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_UPLOAD.MAX_PARTS)
  cursor?: number;
}
