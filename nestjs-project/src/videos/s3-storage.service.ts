import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { S3_CLIENT, S3_PUBLIC_CLIENT, VIDEO_UPLOAD } from './videos.constants';
import { VIDEO_ACCESS } from './videos.constants';
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface UploadedPartsPage {
  parts: UploadedPart[];
  nextCursor: number | null;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export type VideoReadDisposition = 'inline' | 'attachment';

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
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    configService: ConfigService,
  ) {
    this.bucket = configService.getOrThrow<string>('S3_BUCKET');
  }

  async listParts(
    key: string,
    uploadId: string,
    cursor?: number,
  ): Promise<UploadedPartsPage> {
    const page = await this.client.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: cursor === undefined ? undefined : String(cursor),
        MaxParts: VIDEO_UPLOAD.LIST_PARTS_PAGE_SIZE,
      }),
    );
    if (page.IsTruncated && !page.NextPartNumberMarker) {
      throw new Error('Storage returned an incomplete parts pagination cursor');
    }

    return {
      parts: (page.Parts ?? []).flatMap((part) =>
        part.PartNumber !== undefined &&
        part.Size !== undefined &&
        part.ETag !== undefined
          ? [
              {
                partNumber: part.PartNumber,
                size: part.Size,
                etag: part.ETag,
              },
            ]
          : [],
      ),
      nextCursor: page.IsTruncated ? Number(page.NextPartNumberMarker) : null,
    };
  }

  async createPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: VIDEO_UPLOAD.PART_URL_EXPIRATION_SECONDS },
    );
  }

  async createVideoReadUrl(
    key: string,
    disposition: VideoReadDisposition,
    filename?: string,
  ): Promise<string> {
    const responseContentDisposition =
      disposition === 'attachment' && filename
        ? `attachment; filename="${filename}"`
        : 'inline';

    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
        ResponseContentType: 'video/mp4',
      }),
      { expiresIn: VIDEO_ACCESS.URL_EXPIRATION_SECONDS },
    );
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

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
    );
  }

  async getObjectSize(key: string): Promise<number | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.ContentLength ?? null;
    } catch (error) {
      const errorName =
        typeof error === 'object' && error !== null
          ? (error as { name?: unknown }).name
          : undefined;
      const statusCode =
        typeof error === 'object' && error !== null && '$metadata' in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      if (
        errorName === 'NotFound' ||
        errorName === 'NoSuchKey' ||
        statusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async downloadObjectToFile(
    key: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal },
    );
    if (!result.Body) throw new Error('Storage returned an empty video object');
    const body = result.Body as Readable;
    let size = 0;
    body.on('data', (chunk: Buffer | Uint8Array) => {
      size += chunk.byteLength;
      if (size > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
        body.destroy(
          new Error('Video object exceeds the configured size limit'),
        );
      }
    });
    await pipeline(body, createWriteStream(path), { signal });
    if (result.ContentLength !== undefined && size !== result.ContentLength) {
      throw new Error(
        'Downloaded video size does not match the storage metadata',
      );
    }
    return size;
  }

  async uploadThumbnail(
    key: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const thumbnail = await fs.readFile(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: thumbnail,
        ContentType: 'image/jpeg',
      }),
      { abortSignal: signal },
    );
  }

  async abortMultipartUploadsForKey(key: string): Promise<void> {
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
