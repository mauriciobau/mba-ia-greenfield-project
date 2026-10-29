import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD } from '../videos.constants';

export class CreatePartUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD.PART_URL_BATCH_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(VIDEO_UPLOAD.MAX_PARTS, { each: true })
  partNumbers: number[];
}
