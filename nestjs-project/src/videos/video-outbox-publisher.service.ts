import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideosPersistenceService } from './videos.persistence.service';
import {
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_BACKOFF_MS,
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE_CLIENT,
  VIDEO_PROCESSING_RECONCILIATION_GRACE_MS,
  VIDEO_PROCESSING_RECONCILIATION_MS,
  VideoProcessingJobData,
  videoProcessingJobId,
} from './video-queue.constants';

type VideoProcessingQueue = Pick<
  Queue<VideoProcessingJobData>,
  'add' | 'close' | 'getJob'
>;

@Injectable()
export class VideoOutboxPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoOutboxPublisherService.name);
  private readonly queue: VideoProcessingQueue;
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(VIDEO_PROCESSING_QUEUE_CLIENT)
    queue: VideoProcessingQueue,
    private readonly persistence: VideosPersistenceService,
  ) {
    this.queue = queue;
  }

  onApplicationBootstrap(): void {
    void this.reconcile();
    this.interval = setInterval(
      () => void this.reconcile(),
      VIDEO_PROCESSING_RECONCILIATION_MS,
    );
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    await this.queue.close();
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.dataSource
        .getRepository(VideoProcessingOutbox)
        .createQueryBuilder('event')
        .innerJoin('event.video', 'video')
        .where('video.status = :status', { status: 'processing' })
        .andWhere(
          `NOT EXISTS (SELECT 1 FROM video_processing_outbox newer WHERE newer.video_id = event.video_id AND newer.generation > event.generation)`,
        )
        .andWhere(
          `(event.state = :pending OR (event.state = :published AND event.updated_at <= :staleBefore))`,
          {
            pending: 'pending',
            published: 'published',
            staleBefore: new Date(
              Date.now() - VIDEO_PROCESSING_RECONCILIATION_GRACE_MS,
            ),
          },
        )
        .orderBy('event.created_at', 'ASC')
        .take(100)
        .getMany();

      for (const event of events) {
        await this.publish(event);
      }
    } catch (error) {
      this.logger.error(
        `Video outbox reconciliation failed: ${this.errorMessage(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async publish(event: VideoProcessingOutbox): Promise<void> {
    const { id: eventId, video_id: videoId, generation } = event;
    const jobId = videoProcessingJobId(videoId, generation);
    let existing = await this.queue.getJob(jobId);
    if (existing && (await existing.getState()) === 'failed') {
      const recovery = await this.persistence.recoverFailedProcessingJob(
        eventId,
        new Date(Date.now() - VIDEO_PROCESSING_RECONCILIATION_GRACE_MS),
      );
      if (recovery === 'retry') {
        await existing.remove();
        existing = undefined;
      } else {
        return;
      }
    }

    if (!existing) {
      await this.queue.add(
        VIDEO_PROCESSING_JOB,
        { eventId, videoId, generation },
        {
          jobId,
          attempts: VIDEO_PROCESSING_ATTEMPTS,
          backoff: { type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    await this.dataSource
      .createQueryBuilder()
      .update(VideoProcessingOutbox)
      .set({ state: 'published' })
      .where(
        'id = :eventId AND video_id = :videoId AND generation = :generation',
        {
          eventId,
          videoId,
          generation,
        },
      )
      .execute();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
