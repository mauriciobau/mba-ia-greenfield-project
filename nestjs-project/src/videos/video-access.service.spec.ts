import { Video } from './entities/video.entity';
import { VideoAccessService } from './video-access.service';
import { VideosPersistenceService } from './videos.persistence.service';
import { S3StorageService } from './s3-storage.service';

describe('VideoAccessService', () => {
  let service: VideoAccessService;
  let persistence: jest.Mocked<
    Pick<VideosPersistenceService, 'findVideoForOwner'>
  >;
  let storage: jest.Mocked<Pick<S3StorageService, 'createVideoReadUrl'>>;
  const video = {
    public_id: 'public-id',
    object_key: 'videos/channel-id/object/source',
    status: 'ready',
    size_bytes: '1024',
    duration_ms: '15000',
    metadata: { videoCodec: 'h264' },
    error_code: null,
  } as unknown as Video;

  beforeEach(() => {
    persistence = {
      findVideoForOwner: jest.fn().mockResolvedValue(video),
    };
    storage = {
      createVideoReadUrl: jest.fn().mockResolvedValue('https://signed.test/'),
    };
    service = new VideoAccessService(
      persistence as unknown as VideosPersistenceService,
      storage as unknown as S3StorageService,
    );
  });

  it('returns only the documented owned video state and converts database integers', async () => {
    await expect(service.getVideo('owner-id', 'public-id')).resolves.toEqual({
      publicId: 'public-id',
      status: 'ready',
      sizeBytes: 1024,
      durationMs: 15000,
      metadata: { videoCodec: 'h264' },
      errorCode: null,
    });
    expect(persistence.findVideoForOwner).toHaveBeenCalledWith(
      'public-id',
      'owner-id',
    );
  });

  it('hides missing videos and videos owned by another user as not found', async () => {
    persistence.findVideoForOwner.mockResolvedValue(null);
    await expect(
      service.getVideo('stranger-id', 'public-id'),
    ).rejects.toMatchObject({
      errorCode: 'VIDEO_NOT_FOUND',
      httpStatus: 404,
    });
    await expect(
      service.createPlaybackUrl('stranger-id', 'public-id'),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND', httpStatus: 404 });
    expect(storage.createVideoReadUrl).not.toHaveBeenCalled();
  });

  it('blocks every non-ready status from playback and download', async () => {
    for (const status of ['draft', 'processing', 'error'] as const) {
      persistence.findVideoForOwner.mockResolvedValue({ ...video, status });
      await expect(
        service.createPlaybackUrl('owner-id', 'public-id'),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_READY',
        httpStatus: 409,
      });
      await expect(
        service.createDownloadUrl('owner-id', 'public-id'),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_READY',
        httpStatus: 409,
      });
    }
    expect(storage.createVideoReadUrl).not.toHaveBeenCalled();
  });

  it('creates renewable playback and attachment URLs with bounded expiry', async () => {
    const before = Date.now();
    const playback = await service.createPlaybackUrl('owner-id', 'public-id');
    const download = await service.createDownloadUrl('owner-id', 'public-id');
    const after = Date.now();

    expect(playback.url).toBe('https://signed.test/');
    expect(new Date(playback.expiresAt).getTime()).toBeGreaterThan(before);
    expect(new Date(playback.expiresAt).getTime()).toBeLessThanOrEqual(
      after + 5 * 60 * 1000,
    );
    expect(storage.createVideoReadUrl).toHaveBeenNthCalledWith(
      1,
      video.object_key,
      'inline',
      undefined,
    );
    expect(storage.createVideoReadUrl).toHaveBeenNthCalledWith(
      2,
      video.object_key,
      'attachment',
      'video-public-id.mp4',
    );
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(before);
  });

  it('maps storage signing failures without exposing credentials or details', async () => {
    storage.createVideoReadUrl.mockRejectedValue(
      new Error('secret key or access key was rejected'),
    );
    await expect(
      service.createPlaybackUrl('owner-id', 'public-id'),
    ).rejects.toMatchObject({
      errorCode: 'VIDEO_STORAGE_UNAVAILABLE',
      httpStatus: 503,
    });
  });
});
