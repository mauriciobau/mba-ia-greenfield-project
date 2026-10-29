import { Test } from '@nestjs/testing';
import { VideoUpload } from './entities/video-upload.entity';
import { UploadPartsService } from './upload-parts.service';
import { S3StorageService } from './s3-storage.service';
import { VideosPersistenceService } from './videos.persistence.service';
import {
  VideoUploadConflictException,
  VideoUploadInvalidPartsException,
  VideoUploadNotFoundException,
} from './video-upload.exceptions';
import { VIDEO_UPLOAD } from './videos.constants';

describe('UploadPartsService', () => {
  let service: UploadPartsService;
  let persistence: jest.Mocked<
    Pick<VideosPersistenceService, 'findUploadForOwner'>
  >;
  let storage: jest.Mocked<
    Pick<S3StorageService, 'listParts' | 'createPartUrl'>
  >;

  const activeUpload = (): VideoUpload =>
    ({
      id: 'session-id',
      upload_id: 'storage-upload-id',
      state: 'initiated',
      expected_size_bytes: '134217728',
      part_size_bytes: '67108864',
      expires_at: new Date(Date.now() + 60_000),
      video: { object_key: 'videos/key' },
    }) as VideoUpload;

  beforeEach(async () => {
    persistence = { findUploadForOwner: jest.fn() };
    storage = {
      listParts: jest.fn(),
      createPartUrl: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        UploadPartsService,
        { provide: VideosPersistenceService, useValue: persistence },
        { provide: S3StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get(UploadPartsService);
  });

  it('returns paginated storage parts for the owning user', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.listParts.mockResolvedValue({
      parts: [{ partNumber: 1, size: 100, etag: '"etag"' }],
      nextCursor: 1,
    });

    await expect(
      service.list('owner-id', 'session-id', 0),
    ).resolves.toMatchObject({
      state: 'initiated',
      expectedSizeBytes: 134217728,
      partSizeBytes: 67108864,
      parts: [{ partNumber: 1, size: 100, etag: '"etag"' }],
      nextCursor: 1,
    });
    expect(storage.listParts).toHaveBeenCalledWith(
      'videos/key',
      'storage-upload-id',
      0,
    );
  });

  it('hides missing and non-owned sessions behind the same not-found error', async () => {
    persistence.findUploadForOwner.mockResolvedValue(null);
    await expect(
      service.list('other-user', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadNotFoundException);
    await expect(
      service.createPartUrls('other-user', 'session-id', [1]),
    ).rejects.toBeInstanceOf(VideoUploadNotFoundException);
    expect(storage.listParts).not.toHaveBeenCalled();
    expect(storage.createPartUrl).not.toHaveBeenCalled();
  });

  it('rejects completed or expired sessions before storage access', async () => {
    const upload = activeUpload();
    upload.state = 'completed';
    persistence.findUploadForOwner.mockResolvedValue(upload);
    await expect(service.list('owner-id', 'session-id')).rejects.toBeInstanceOf(
      VideoUploadConflictException,
    );

    upload.state = 'initiated';
    upload.expires_at = new Date(Date.now() - 1);
    await expect(
      service.createPartUrls('owner-id', 'session-id', [1]),
    ).rejects.toBeInstanceOf(VideoUploadConflictException);
    expect(storage.listParts).not.toHaveBeenCalled();
  });

  it('limits requested part numbers to the expected part count and batch size', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    await expect(
      service.createPartUrls('owner-id', 'session-id', [3]),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    await expect(
      service.createPartUrls('owner-id', 'session-id', [1, 1]),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    await expect(
      service.createPartUrls(
        'owner-id',
        'session-id',
        Array.from(
          { length: VIDEO_UPLOAD.PART_URL_BATCH_LIMIT + 1 },
          (_, index) => index + 1,
        ),
      ),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    expect(storage.createPartUrl).not.toHaveBeenCalled();
  });

  it('returns renewed URLs with bounded expirations for active sessions', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.createPartUrl.mockResolvedValue('http://public-storage/part');

    const result = await service.createPartUrls(
      'owner-id',
      'session-id',
      [1, 2],
    );

    expect(storage.createPartUrl).toHaveBeenNthCalledWith(
      1,
      'videos/key',
      'storage-upload-id',
      1,
    );
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].url).toContain('http://public-storage');
    expect(new Date(result.parts[0].expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(new Date(result.parts[0].expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + VIDEO_UPLOAD.PART_URL_EXPIRATION_SECONDS * 1000,
    );
  });
});
