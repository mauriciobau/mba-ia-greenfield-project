import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Video } from './video.entity';

export type VideoUploadState =
  | 'initiated'
  | 'completing'
  | 'completed'
  | 'aborted';

@Entity('video_uploads')
@Check(
  'CHK_video_uploads_state',
  `"state" IN ('initiated', 'completing', 'completed', 'aborted')`,
)
@Check(
  'CHK_video_uploads_sizes',
  '"expected_size_bytes" > 0 AND "expected_size_bytes" <= 10000000000 AND "part_size_bytes" > 0',
)
export class VideoUpload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  video_id: string;

  @Column({ type: 'text' })
  upload_id: string;

  @Column({ type: 'bigint' })
  expected_size_bytes: string;

  @Column({ type: 'bigint' })
  part_size_bytes: string;

  @Column({ type: 'varchar', default: 'initiated' })
  state: VideoUploadState;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @OneToOne(() => Video, (video) => video.upload, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
