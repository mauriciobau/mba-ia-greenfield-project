import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Video } from './video.entity';

export type VideoProcessingOutboxState = 'pending' | 'published';

@Entity('video_processing_outbox')
@Unique('UQ_video_processing_outbox_video_generation', [
  'video_id',
  'generation',
])
@Check(
  'CHK_video_processing_outbox_state',
  `"state" IN ('pending', 'published')`,
)
@Check('CHK_video_processing_outbox_generation', '"generation" > 0')
@Check(
  'CHK_video_processing_outbox_execution_lease',
  '("execution_token" IS NULL) = ("lease_expires_at" IS NULL)',
)
@Check('CHK_video_processing_outbox_recovery_count', '"recovery_count" >= 0')
export class VideoProcessingOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  video_id: string;

  @Column({ type: 'integer' })
  generation: number;

  @Column({ type: 'varchar', default: 'pending' })
  state: VideoProcessingOutboxState;

  @Column({ type: 'uuid', nullable: true })
  execution_token: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lease_expires_at: Date | null;

  @Column({ type: 'integer', default: 0 })
  recovery_count: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Video, (video) => video.processing_events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
