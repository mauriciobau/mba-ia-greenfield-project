import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosPersistenceService } from './videos.persistence.service';

describe('Videos persistence (integration)', () => {
  let dataSource: DataSource;
  let persistence: VideosPersistenceService;
  let userIds: string[];
  let channelIds: string[];
  let videoIds: string[];
  let fixtureCounter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
      { synchronize: false },
    );
    await dataSource.initialize();
    persistence = new VideosPersistenceService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(() => {
    userIds = [];
    channelIds = [];
    videoIds = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    if (videoIds.length > 0) {
      await dataSource
        .getRepository(Video)
        .delete(videoIds.map((id) => ({ id })));
    }
    if (channelIds.length > 0) {
      await dataSource
        .getRepository(Channel)
        .delete(channelIds.map((id) => ({ id })));
    }
    if (userIds.length > 0) {
      await dataSource
        .getRepository(User)
        .delete(userIds.map((id) => ({ id })));
    }
  });

  async function createChannel(): Promise<Channel> {
    const suffix = `${Date.now()}_${++fixtureCounter}`;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `video_persistence_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    userIds.push(user.id);

    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Video persistence test channel',
        nickname: `video_${suffix}`,
        user_id: user.id,
      }),
    );
    channelIds.push(channel.id);
    return channel;
  }

  async function createDraft(
    channelId: string,
    keySuffix: string,
  ): Promise<Video> {
    const video = await persistence.createDraft(
      channelId,
      `video-persistence/${keySuffix}`,
      '100',
    );
    videoIds.push(video.id);
    return video;
  }

  it('retries a public_id collision while creating a draft', async () => {
    const channel = await createChannel();
    const existingVideo = await createDraft(channel.id, 'existing');
    const nextPublicId = `recovered_${Date.now()}`;
    const generator = jest
      .spyOn(persistence, 'generatePublicId')
      .mockReturnValueOnce(existingVideo.public_id)
      .mockReturnValueOnce(nextPublicId);

    const video = await createDraft(channel.id, 'after-collision');

    expect(video.public_id).toBe(nextPublicId);
    expect(generator).toHaveBeenCalledTimes(2);
    generator.mockRestore();
  });

  it('keeps draft status when writing the outbox fails in the transaction', async () => {
    const channel = await createChannel();
    const video = await createDraft(channel.id, 'outbox-rollback');
    await dataSource.getRepository(VideoProcessingOutbox).save(
      dataSource.getRepository(VideoProcessingOutbox).create({
        video_id: video.id,
        generation: 1,
        state: 'pending',
      }),
    );

    await expect(persistence.startProcessing(video.id, 1)).rejects.toThrow();

    const persistedVideo = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(persistedVideo.status).toBe('draft');
  });

  it('atomically transitions draft and inserts one outbox event under concurrency', async () => {
    const channel = await createChannel();
    const video = await createDraft(channel.id, 'concurrent-transition');

    const results = await Promise.all([
      persistence.startProcessing(video.id, 1),
      persistence.startProcessing(video.id, 2),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const persistedVideo = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    const outboxEvents = await dataSource
      .getRepository(VideoProcessingOutbox)
      .findBy({ video_id: video.id });

    expect(persistedVideo.status).toBe('processing');
    expect(outboxEvents).toHaveLength(1);
  });

  it('loads a multipart upload only for the owning channel user', async () => {
    const channel = await createChannel();
    const video = await createDraft(channel.id, 'owner-session');
    const upload = await persistence.createUploadSession(
      video.id,
      'storage-upload-id',
      '100',
      '64',
      new Date(Date.now() + 60_000),
    );

    const owner = await persistence.findUploadForOwner(
      upload.id,
      channel.user_id,
    );
    const nonOwner = await persistence.findUploadForOwner(
      upload.id,
      '00000000-0000-4000-8000-000000000001',
    );
    const unknown = await persistence.findUploadForOwner(
      '00000000-0000-4000-8000-000000000002',
      channel.user_id,
    );

    expect(owner?.id).toBe(upload.id);
    expect(owner?.video.object_key).toBe(video.object_key);
    expect(nonOwner).toBeNull();
    expect(unknown).toBeNull();
  });
});
