import { Test } from '@nestjs/testing';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  MultipartUploadCleanupFailedError,
  S3StorageService,
} from './s3-storage.service';
import { UploadInitService } from './upload-init.service';
import { VideosPersistenceService } from './videos.persistence.service';
import { VIDEO_UPLOAD } from './videos.constants';
import {
  VideoStorageUnavailableException,
  VideoUploadTooLargeException,
} from './video-upload.exceptions';

describe('UploadInitService', () => {
  let service: UploadInitService;
  let channels: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let persistence: jest.Mocked<
    Pick<
      VideosPersistenceService,
      'createDraft' | 'createUploadSession' | 'deleteDraft'
    >
  >;
  let storage: jest.Mocked<
    Pick<S3StorageService, 'createMultipartUpload' | 'abortMultipartUpload'>
  >;

  beforeEach(async () => {
    channels = { findByUserId: jest.fn() };
    persistence = {
      createDraft: jest.fn(),
      createUploadSession: jest.fn(),
      deleteDraft: jest.fn(),
    };
    storage = {
      createMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        UploadInitService,
        { provide: ChannelsService, useValue: channels },
        { provide: VideosPersistenceService, useValue: persistence },
        { provide: S3StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(UploadInitService);
  });

  it('rejects a size above the limit before touching the database or storage', async () => {
    await expect(
      service.start('user-id', VIDEO_UPLOAD.MAX_SIZE_BYTES + 1, 'video/mp4'),
    ).rejects.toBeInstanceOf(VideoUploadTooLargeException);
    expect(channels.findByUserId).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('deletes the draft and maps storage initiation failures to 503', async () => {
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' } as Channel);
    persistence.createDraft.mockResolvedValue({
      id: 'video-id',
      object_key: 'videos/key',
    } as never);
    storage.createMultipartUpload.mockRejectedValue(
      new Error('network timeout'),
    );

    await expect(
      service.start('user-id', 100, 'video/mp4'),
    ).rejects.toBeInstanceOf(VideoStorageUnavailableException);

    expect(persistence.deleteDraft).toHaveBeenCalledWith('video-id');
    expect(persistence.createUploadSession).not.toHaveBeenCalled();
  });

  it('preserves the draft when cleanup after a failed storage initiation fails', async () => {
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' } as Channel);
    persistence.createDraft.mockResolvedValue({
      id: 'video-id',
      object_key: 'videos/key',
    } as never);
    storage.createMultipartUpload.mockRejectedValue(
      new MultipartUploadCleanupFailedError(),
    );

    await expect(
      service.start('user-id', 100, 'video/mp4'),
    ).rejects.toBeInstanceOf(VideoStorageUnavailableException);

    expect(persistence.deleteDraft).not.toHaveBeenCalled();
  });

  it('aborts the storage upload and removes the draft when session persistence fails', async () => {
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' } as Channel);
    persistence.createDraft.mockResolvedValue({
      id: 'video-id',
      object_key: 'videos/key',
    } as never);
    storage.createMultipartUpload.mockResolvedValue('storage-upload-id');
    storage.abortMultipartUpload
      .mockRejectedValueOnce(new Error('temporary abort timeout'))
      .mockResolvedValueOnce(undefined);
    persistence.createUploadSession.mockRejectedValue(
      new Error('database error'),
    );

    await expect(service.start('user-id', 100, 'video/mp4')).rejects.toThrow(
      'database error',
    );

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      storage.createMultipartUpload.mock.calls[0][0],
      'storage-upload-id',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(persistence.deleteDraft).toHaveBeenCalledWith('video-id');
  });

  it('returns the public upload session id and hides the storage upload id', async () => {
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' } as Channel);
    persistence.createDraft.mockResolvedValue({
      id: 'video-id',
      public_id: 'public-id',
      object_key: 'videos/key',
    } as never);
    storage.createMultipartUpload.mockResolvedValue('storage-secret-id');
    persistence.createUploadSession.mockResolvedValue({
      id: 'public-session-id',
    } as never);

    const result = await service.start('user-id', 100, 'video/mp4');

    expect(result).toMatchObject({
      videoId: 'video-id',
      publicId: 'public-id',
      uploadId: 'public-session-id',
      status: 'draft',
    });
    expect(JSON.stringify(result)).not.toContain('storage-secret-id');
  });

  it('preserves the draft when abort compensation remains unavailable after retry', async () => {
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' } as Channel);
    persistence.createDraft.mockResolvedValue({
      id: 'video-id',
      object_key: 'videos/key',
    } as never);
    storage.createMultipartUpload.mockResolvedValue('storage-upload-id');
    storage.abortMultipartUpload.mockRejectedValue(
      new Error('storage remains unavailable'),
    );
    persistence.createUploadSession.mockRejectedValue(
      new Error('database error'),
    );

    await expect(
      service.start('user-id', 100, 'video/mp4'),
    ).rejects.toBeInstanceOf(VideoStorageUnavailableException);

    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(persistence.deleteDraft).not.toHaveBeenCalled();
  });
});
