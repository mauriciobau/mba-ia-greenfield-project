import { Job, Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createIsolatedVideoDataSource } from '../test/create-isolated-video-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJobData,
  videoProcessingJobId,
} from './video-queue.constants';
import { VideoOutboxPublisherService } from './video-outbox-publisher.service';
import { VideosPersistenceService } from './videos.persistence.service';

describe('Video outbox publisher (integration)', () => {
  let dataSource: DataSource;
  let queue: Queue<VideoProcessingJobData>;
  let publisher: VideoOutboxPublisherService;
  let persistence: VideosPersistenceService;
  let cleanupDatabase: () => Promise<void>;
  let failureWorker: Worker<VideoProcessingJobData> | undefined;
  let videoId: string;
  let eventId: string;
  let userId: string;
  let channelId: string;
  const suffix = randomUUID();
  const queueName = `${VIDEO_PROCESSING_QUEUE}-integration-${suffix}`;

  beforeAll(async () => {
    const isolated = await createIsolatedVideoDataSource();
    dataSource = isolated.dataSource;
    cleanupDatabase = isolated.cleanup;
    persistence = new VideosPersistenceService(dataSource);
    queue = new Queue<VideoProcessingJobData>(queueName, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null,
      },
    });
    publisher = new VideoOutboxPublisherService(dataSource, queue, persistence);
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await publisher?.onModuleDestroy();
    await cleanupDatabase?.();
  });

  beforeEach(async () => {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `video_queue_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Video queue integration',
        nickname: `video_queue_${suffix}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    const video = await persistence.createDraft(
      channel.id,
      `integration-tests/${suffix}/source`,
      '1024',
    );
    videoId = video.id;
    await persistence.startProcessing(video.id, 1);
    eventId = (
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .findOneByOrFail({ video_id: video.id, generation: 1 })
    ).id;
  });

  afterEach(async () => {
    await failureWorker?.close();
    failureWorker = undefined;
    await queue.drain(true);
    jest.restoreAllMocks();
    if (videoId) await dataSource.getRepository(Video).delete({ id: videoId });
    if (channelId)
      await dataSource.getRepository(Channel).delete({ id: channelId });
    if (userId) await dataSource.getRepository(User).delete({ id: userId });
  });

  it('publishes the pending transactional outbox event with bounded retries', async () => {
    await publisher.reconcile();

    const jobId = videoProcessingJobId(videoId, 1);
    const job = await queue.getJob(jobId);
    expect(job?.data).toEqual({ eventId, videoId, generation: 1 });
    expect(job?.opts).toMatchObject({ attempts: 3 });
    expect(job?.opts.backoff).toMatchObject({
      type: 'exponential',
      delay: 5000,
    });
    expect(
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .findOneByOrFail({ video_id: videoId, generation: 1 }),
    ).toMatchObject({ state: 'published' });
  });

  it('allows a worker to claim the job while the outbox publisher is adding it', async () => {
    let resolveClaim: (claimed: boolean) => void = () => undefined;
    const claimAttempt = new Promise<boolean>((resolve) => {
      resolveClaim = resolve;
    });
    failureWorker = new Worker<VideoProcessingJobData>(
      queueName,
      async (job) => {
        const executionToken = randomUUID();
        const claimed = await persistence.claimProcessingExecution(
          job.data.eventId,
          job.data.videoId,
          job.data.generation,
          executionToken,
          new Date(Date.now() + 60_000),
        );
        resolveClaim(claimed);
        if (claimed) {
          await persistence.releaseProcessingExecution(
            job.data.eventId,
            job.data.videoId,
            job.data.generation,
            executionToken,
          );
        }
      },
      {
        connection: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: null,
        },
      },
    );
    await failureWorker.waitUntilReady();

    let claimSucceeded = false;
    const racingPublisher = new VideoOutboxPublisherService(
      dataSource,
      {
        getJob: (jobId) => queue.getJob(jobId),
        add: async (name, data, options) => {
          const job = await queue.add(name, data, options);
          claimSucceeded = await claimAttempt;
          return job;
        },
        close: () => queue.close(),
      },
      persistence,
    );

    await racingPublisher.reconcile();

    expect(claimSucceeded).toBe(true);
    expect(
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .findOneByOrFail({ id: eventId }),
    ).toMatchObject({ state: 'published', execution_token: null });
    // The claim assertion above covers the race; the completed job may have
    // already been removed by the removeOnComplete policy.
  }, 15_000);

  it('recreates a published job missing from Redis after the recovery grace period', async () => {
    await publisher.reconcile();
    const jobId = videoProcessingJobId(videoId, 1);
    const accepted = await queue.getJob(jobId);
    expect(accepted).toBeDefined();
    await accepted?.remove();
    await dataSource.query(
      `UPDATE video_processing_outbox SET updated_at = $1 WHERE video_id = $2 AND generation = 1`,
      [new Date(Date.now() - 120_000), videoId],
    );

    await publisher.reconcile();

    expect(await queue.getJob(jobId)).toMatchObject({
      data: { eventId, videoId, generation: 1 },
    });
  });

  it('recovers failed jobs a bounded number of times, then persists terminal error', async () => {
    const jobId = videoProcessingJobId(videoId, 1);
    await queue.add(
      'failed-processing-test',
      { eventId, videoId, generation: 1 },
      { jobId, attempts: 1, removeOnFail: false },
    );
    failureWorker = new Worker<VideoProcessingJobData>(
      queueName,
      async () => Promise.reject(new Error('simulated processing failure')),
      {
        connection: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: null,
        },
      },
    );
    await waitForFailedJob(queue, jobId);
    await failureWorker.close();
    failureWorker = undefined;
    await dataSource.query(
      'UPDATE video_processing_outbox SET updated_at = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), eventId],
    );
    await publisher.reconcile();

    const requeued = await queue.getJob(jobId);
    expect(requeued?.opts.attempts).toBe(3);
    expect(await requeued?.getState()).toBe('waiting');
    expect(
      (
        await dataSource
          .getRepository(VideoProcessingOutbox)
          .findOneByOrFail({ id: eventId })
      ).recovery_count,
    ).toBe(1);

    for (const expectedCount of [2, 3]) {
      await dataSource.query(
        'UPDATE video_processing_outbox SET updated_at = $1 WHERE id = $2',
        [new Date(Date.now() - 120_000), eventId],
      );
      await expect(
        persistence.recoverFailedProcessingJob(
          eventId,
          new Date(Date.now() - 60_000),
        ),
      ).resolves.toBe('retry');
      expect(
        (
          await dataSource
            .getRepository(VideoProcessingOutbox)
            .findOneByOrFail({ id: eventId })
        ).recovery_count,
      ).toBe(expectedCount);
    }
    await dataSource.query(
      'UPDATE video_processing_outbox SET updated_at = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), eventId],
    );
    await expect(
      persistence.recoverFailedProcessingJob(
        eventId,
        new Date(Date.now() - 60_000),
      ),
    ).resolves.toBe('exhausted');
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    expect(video.status).toBe('error');
    expect(video.error_code).toBe('VIDEO_PROCESSING_FAILED');
  }, 30_000);

  it('ignores a failed older generation while publishing the current generation', async () => {
    const newerEvent = await dataSource
      .getRepository(VideoProcessingOutbox)
      .save(
        dataSource.getRepository(VideoProcessingOutbox).create({
          video_id: videoId,
          generation: 2,
          state: 'pending',
        }),
      );
    const oldJobId = videoProcessingJobId(videoId, 1);
    await queue.add(
      'failed-old-generation-test',
      { eventId, videoId, generation: 1 },
      { jobId: oldJobId, attempts: 1, removeOnFail: false },
    );
    failureWorker = new Worker<VideoProcessingJobData>(
      queueName,
      async () => Promise.reject(new Error('old generation failed')),
      {
        connection: {
          host: process.env.REDIS_HOST ?? 'redis',
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: null,
        },
      },
    );
    await waitForFailedJob(queue, oldJobId);
    await failureWorker.close();
    failureWorker = undefined;
    await dataSource.query(
      'UPDATE video_processing_outbox SET updated_at = $1 WHERE id = $2',
      [new Date(Date.now() - 120_000), eventId],
    );

    await publisher.reconcile();

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    const oldEvent = await dataSource
      .getRepository(VideoProcessingOutbox)
      .findOneByOrFail({ id: eventId });
    expect(video.status).toBe('processing');
    expect(oldEvent.recovery_count).toBe(0);
    expect(await (await queue.getJob(oldJobId))?.getState()).toBe('failed');
    expect(await queue.getJob(videoProcessingJobId(videoId, 2))).toMatchObject({
      data: {
        eventId: newerEvent.id,
        videoId,
        generation: 2,
      },
    });
  }, 15_000);
});

async function waitForFailedJob(
  queue: Queue<VideoProcessingJobData>,
  jobId: string,
): Promise<Job<VideoProcessingJobData>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} did not reach failed state`);
}
