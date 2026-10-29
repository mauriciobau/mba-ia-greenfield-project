import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { S3_CLIENT } from './videos.constants';

export class MultipartUploadCleanupFailedError extends Error {
  constructor() {
    super('Multipart upload cleanup could not be confirmed');
    this.name = MultipartUploadCleanupFailedError.name;
  }
}

@Injectable()
export class S3StorageService {
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    configService: ConfigService,
  ) {
    this.bucket = configService.getOrThrow<string>('S3_BUCKET');
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    try {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );

      if (!result.UploadId) {
        throw new Error('Storage did not return an upload identifier');
      }
      return result.UploadId;
    } catch (error) {
      // A network failure can occur after S3 created the upload but before the
      // response reached us. The unique object key lets us find and abort it.
      try {
        await this.abortMultipartUploadsForKey(key);
      } catch {
        throw new MultipartUploadCleanupFailedError();
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      const errorName =
        typeof error === 'object' && error !== null
          ? (error as { name?: unknown }).name
          : undefined;
      if (errorName === 'NoSuchUpload' || errorName === 'NotFound') {
        return;
      }
      throw error;
    }
  }

  private async abortMultipartUploadsForKey(key: string): Promise<void> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      const exactMatches = (page.Uploads ?? []).filter(
        (upload) => upload.Key === key && upload.UploadId,
      );
      for (const upload of exactMatches) {
        await this.abortMultipartUpload(key, upload.UploadId!);
      }

      if (!page.IsTruncated) return;
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
      if (keyMarker === undefined && uploadIdMarker === undefined) {
        throw new Error(
          'Storage returned an incomplete multipart pagination cursor',
        );
      }
    } while (keyMarker !== undefined || uploadIdMarker !== undefined);
  }
}
