import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoProcessingOutbox } from './video-processing-outbox.entity';
import { VideoUpload } from './video-upload.entity';

export type VideoStatus = 'draft' | 'processing' | 'ready' | 'error';

@Entity('videos')
@Index('UQ_videos_public_id', ['public_id'], { unique: true })
@Index('UQ_videos_object_key', ['object_key'], { unique: true })
@Check(
  'CHK_videos_status',
  `"status" IN ('draft', 'processing', 'ready', 'error')`,
)
@Check(
  'CHK_videos_size_bytes',
  '"size_bytes" > 0 AND "size_bytes" <= 10000000000',
)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar' })
  public_id: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: VideoStatus;

  @Column({ type: 'varchar' })
  object_key: string;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'bigint' })
  size_bytes: string;

  @Column({ type: 'bigint', nullable: true })
  duration_ms: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  error_code: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @OneToOne(() => VideoUpload, (upload) => upload.video)
  upload: VideoUpload;

  @OneToMany(() => VideoProcessingOutbox, (outbox) => outbox.video)
  processing_events: VideoProcessingOutbox[];
}
