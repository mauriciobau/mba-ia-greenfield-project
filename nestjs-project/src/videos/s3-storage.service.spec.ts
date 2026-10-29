import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import {
  MultipartUploadCleanupFailedError,
  S3StorageService,
} from './s3-storage.service';

describe('S3StorageService', () => {
  it('returns ListParts results and the S3 continuation marker', async () => {
    const commands: unknown[] = [];
    const client = {
      send: jest.fn((command: unknown) => {
        commands.push(command);
        return Promise.resolve({
          IsTruncated: true,
          NextPartNumberMarker: '1000',
          Parts: [{ PartNumber: 1, Size: 20, ETag: '"etag"' }],
        });
      }),
    } as unknown as S3Client;
    const config = { getOrThrow: () => 'videos' } as unknown as ConfigService;
    const service = new S3StorageService(client, client, config);

    await expect(
      service.listParts('videos/key', 'storage-id', 50),
    ).resolves.toEqual({
      parts: [{ partNumber: 1, size: 20, etag: '"etag"' }],
      nextCursor: 1000,
    });
    expect(commands[0]).toBeInstanceOf(ListPartsCommand);
    expect((commands[0] as ListPartsCommand).input).toMatchObject({
      Bucket: 'videos',
      Key: 'videos/key',
      UploadId: 'storage-id',
      PartNumberMarker: '50',
      MaxParts: 1000,
    });
  });

  it('finds and aborts an upload when create response is lost', async () => {
    const key = 'videos/channel-id/unique-key/source';
    const commands: unknown[] = [];
    const send = jest.fn((command: unknown): Promise<unknown> => {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.reject(
          new Error('network timeout after server accepted'),
        );
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return Promise.resolve({
          IsTruncated: false,
          Uploads: [{ Key: key, UploadId: 'orphan-upload-id' }],
        });
      }
      return Promise.resolve({});
    });
    const client = {
      send: (command: unknown) => send(command),
    } as unknown as S3Client;
    const config = {
      getOrThrow: () => 'videos',
    } as unknown as ConfigService;
    const service = new S3StorageService(client, client, config);

    await expect(
      service.createMultipartUpload(key, 'video/mp4'),
    ).rejects.toThrow('network timeout');

    expect(commands[0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(commands[1]).toBeInstanceOf(ListMultipartUploadsCommand);
    expect(commands[2]).toBeInstanceOf(AbortMultipartUploadCommand);
    const abortCommand = commands[2];
    if (abortCommand instanceof AbortMultipartUploadCommand) {
      expect(abortCommand.input).toEqual({
        Bucket: 'videos',
        Key: key,
        UploadId: 'orphan-upload-id',
      });
    }
  });

  it('treats aborting an already removed upload as success for safe retries', async () => {
    const send = jest.fn().mockRejectedValue({ name: 'NoSuchUpload' });
    const client = { send } as unknown as S3Client;
    const config = {
      getOrThrow: () => 'videos',
    } as unknown as ConfigService;
    const service = new S3StorageService(client, client, config);

    await expect(
      service.abortMultipartUpload('videos/key', 'removed-upload-id'),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports failed compensation after an uncertain create request', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('create response lost'))
      .mockRejectedValueOnce(new Error('multipart listing unavailable'));
    const client = { send } as unknown as S3Client;
    const config = {
      getOrThrow: () => 'videos',
    } as unknown as ConfigService;
    const service = new S3StorageService(client, client, config);

    await expect(
      service.createMultipartUpload('videos/channel/key/source', 'video/mp4'),
    ).rejects.toBeInstanceOf(MultipartUploadCleanupFailedError);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
