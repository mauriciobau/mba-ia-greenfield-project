import { Test } from '@nestjs/testing';
import { VideoUpload } from './entities/video-upload.entity';
import { UploadCompletionService } from './upload-completion.service';
import { S3StorageService } from './s3-storage.service';
import { VideosPersistenceService } from './videos.persistence.service';
import {
  VideoStorageUnavailableException,
  VideoUploadConflictException,
  VideoUploadInvalidPartsException,
} from './video-upload.exceptions';

const PART_SIZE = 5 * 1024 * 1024;

describe('UploadCompletionService', () => {
  let service: UploadCompletionService;
  let persistence: jest.Mocked<
    Pick<
      VideosPersistenceService,
      | 'findUploadForOwner'
      | 'claimUploadCompletion'
      | 'renewUploadCompletion'
      | 'resetUploadCompletion'
      | 'abortUpload'
      | 'rejectCompletedUpload'
      | 'finishUpload'
    >
  >;
  let storage: jest.Mocked<
    Pick<
      S3StorageService,
      | 'getObjectSize'
      | 'listParts'
      | 'completeMultipartUpload'
      | 'deleteObject'
      | 'abortMultipartUpload'
    >
  >;

  const activeUpload = (): VideoUpload =>
    ({
      id: 'session-id',
      video_id: 'video-id',
      upload_id: 'storage-session-id',
      state: 'initiated',
      expected_size_bytes: String(PART_SIZE),
      expires_at: new Date(Date.now() + 60_000),
      video: { object_key: 'videos/source' },
    }) as VideoUpload;

  beforeEach(async () => {
    persistence = {
      findUploadForOwner: jest.fn(),
      claimUploadCompletion: jest.fn().mockResolvedValue('lease-token'),
      renewUploadCompletion: jest.fn().mockResolvedValue(true),
      resetUploadCompletion: jest.fn().mockResolvedValue(true),
      abortUpload: jest.fn().mockResolvedValue(true),
      rejectCompletedUpload: jest.fn().mockResolvedValue(true),
      finishUpload: jest.fn().mockResolvedValue('completed'),
    };
    storage = {
      getObjectSize: jest.fn(),
      listParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
      deleteObject: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        UploadCompletionService,
        { provide: VideosPersistenceService, useValue: persistence },
        { provide: S3StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get(UploadCompletionService);
  });

  it('completes with storage ETags and records one processing transition', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.getObjectSize
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(PART_SIZE);
    storage.listParts.mockResolvedValue({
      parts: [{ partNumber: 1, size: PART_SIZE, etag: '"etag-v1"' }],
      nextCursor: null,
    });

    await expect(service.complete('owner-id', 'session-id')).resolves.toEqual({
      videoId: 'video-id',
      status: 'processing',
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/source',
      'storage-session-id',
      [{ partNumber: 1, etag: '"etag-v1"' }],
    );
    expect(persistence.finishUpload).toHaveBeenCalledWith(
      'session-id',
      'video-id',
      String(PART_SIZE),
      'lease-token',
    );
  });

  it('uses a completed object to recover a lost storage response without replaying parts', async () => {
    const upload = activeUpload();
    upload.state = 'completing';
    persistence.findUploadForOwner.mockResolvedValue(upload);
    storage.getObjectSize.mockResolvedValue(PART_SIZE);

    await service.complete('owner-id', 'session-id');

    expect(storage.listParts).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(persistence.finishUpload).toHaveBeenCalledWith(
      'session-id',
      'video-id',
      String(PART_SIZE),
      'lease-token',
    );
  });

  it('rejects non-contiguous or size-mismatched parts and makes the session retryable', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.getObjectSize.mockResolvedValue(null);
    storage.listParts.mockResolvedValue({
      parts: [{ partNumber: 2, size: PART_SIZE, etag: '"etag"' }],
      nextCursor: null,
    });

    await expect(
      service.complete('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    expect(persistence.resetUploadCompletion).toHaveBeenCalledWith(
      'session-id',
      'lease-token',
    );
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('uses the listed ETag as the CompleteMultipartUpload precondition', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.getObjectSize
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    storage.listParts.mockResolvedValue({
      parts: [{ partNumber: 1, size: PART_SIZE, etag: '"before-overwrite"' }],
      nextCursor: null,
    });
    storage.completeMultipartUpload.mockRejectedValue({ name: 'InvalidPart' });

    await expect(
      service.complete('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/source',
      'storage-session-id',
      [{ partNumber: 1, etag: '"before-overwrite"' }],
    );
    expect(persistence.resetUploadCompletion).toHaveBeenCalledWith(
      'session-id',
      'lease-token',
    );
    expect(persistence.finishUpload).not.toHaveBeenCalled();
  });

  it('rejects a non-advancing storage pagination cursor instead of looping', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.getObjectSize.mockResolvedValue(null);
    storage.listParts.mockResolvedValue({
      parts: [{ partNumber: 1, size: PART_SIZE, etag: '"etag"' }],
      nextCursor: 1,
    });

    await expect(
      service.complete('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    expect(storage.listParts).toHaveBeenCalledTimes(1);
    expect(persistence.resetUploadCompletion).toHaveBeenCalledWith(
      'session-id',
      'lease-token',
    );
  });

  it('returns conflict when abort has already won the state transition', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    persistence.claimUploadCompletion.mockResolvedValue(null);

    await expect(
      service.complete('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadConflictException);
    expect(storage.getObjectSize).not.toHaveBeenCalled();
  });

  it('keeps a rejected object out of processing and removes its storage object', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.getObjectSize.mockResolvedValue(PART_SIZE + 1);

    await expect(
      service.complete('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoUploadInvalidPartsException);
    expect(storage.deleteObject).toHaveBeenCalledWith('videos/source');
    expect(persistence.rejectCompletedUpload).toHaveBeenCalledWith(
      'session-id',
      'lease-token',
    );
    expect(persistence.finishUpload).not.toHaveBeenCalled();
  });

  it('aborts idempotently while retaining the draft for recovery', async () => {
    const upload = activeUpload();
    upload.state = 'aborted';
    persistence.findUploadForOwner.mockResolvedValue(upload);

    await service.abort('owner-id', 'session-id');

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/source',
      'storage-session-id',
    );
  });

  it('reports a storage cleanup failure so DELETE can be retried', async () => {
    persistence.findUploadForOwner.mockResolvedValue(activeUpload());
    storage.abortMultipartUpload.mockRejectedValue(
      new Error('storage offline'),
    );

    await expect(
      service.abort('owner-id', 'session-id'),
    ).rejects.toBeInstanceOf(VideoStorageUnavailableException);
    expect(persistence.abortUpload).toHaveBeenCalledWith('session-id');
  });
});
