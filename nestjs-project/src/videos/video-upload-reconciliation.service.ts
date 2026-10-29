import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { VideoUpload } from './entities/video-upload.entity';
import { UploadCompletionService } from './upload-completion.service';
import { S3StorageService } from './s3-storage.service';
import { VIDEO_UPLOAD } from './videos.constants';
import { VideosPersistenceService } from './videos.persistence.service';
import { VideoUploadConflictException } from './video-upload.exceptions';

const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_DRAFT_GRACE_MS = VIDEO_UPLOAD.EXPIRATION_MS + 60 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 100;

@Injectable()
export class VideoUploadReconciliationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoUploadReconciliationService.name);
  private interval: NodeJS.Timeout | undefined;
  private isReconciling = false;

  constructor(
    private readonly persistence: VideosPersistenceService,
    private readonly storage: S3StorageService,
    private readonly completion: UploadCompletionService,
  ) {}

  onApplicationBootstrap(): void {
    void this.reconcilePendingUploads();
    this.interval = setInterval(() => {
      void this.reconcilePendingUploads();
    }, RECONCILIATION_INTERVAL_MS);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async reconcilePendingUploads(): Promise<void> {
    if (this.isReconciling) return;
    this.isReconciling = true;
    try {
      await this.reconcileSessions();
      await this.reconcileDraftsWithoutSessions();
    } catch (error) {
      this.logger.error(
        `Upload reconciliation cycle failed: ${this.errorMessage(error)}`,
      );
    } finally {
      this.isReconciling = false;
    }
  }

  private async reconcileSessions(): Promise<void> {
    const uploads = await this.persistence.findUploadSessionsToReconcile(
      new Date(),
    );
    for (const upload of uploads.slice(0, RECONCILIATION_BATCH_SIZE)) {
      try {
        await this.reconcileSession(upload);
      } catch (error) {
        if (!(error instanceof VideoUploadConflictException)) {
          this.logger.warn(
            `Upload session ${upload.id} remains recoverable after reconciliation failure: ${this.errorMessage(error)}`,
          );
        }
      } finally {
        try {
          await this.persistence.touchUploadReconciliation(upload.id);
        } catch (error) {
          this.logger.warn(
            `Could not update reconciliation cursor for upload ${upload.id}: ${this.errorMessage(error)}`,
          );
        }
      }
    }
  }

  private async reconcileSession(upload: VideoUpload): Promise<void> {
    const userId = upload.video.channel.user_id;
    if (upload.state === 'completing') {
      await this.completion.complete(userId, upload.id);
      return;
    }
    if (upload.state === 'aborted') {
      await this.completion.cleanupAbortedStorage(upload);
      return;
    }
    await this.completion.abort(userId, upload.id);
  }

  private async reconcileDraftsWithoutSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_DRAFT_GRACE_MS);
    const drafts = await this.persistence.findOrphanDrafts(
      cutoff,
      RECONCILIATION_BATCH_SIZE,
    );
    for (const draft of drafts) {
      try {
        await this.storage.abortMultipartUploadsForKey(draft.object_key);
        await this.storage.deleteObject(draft.object_key);
        await this.persistence.deleteOrphanDraft(draft.id, cutoff);
      } catch (error) {
        this.logger.warn(
          `Orphan draft ${draft.id} remains recoverable after storage cleanup failure: ${this.errorMessage(error)}`,
        );
      } finally {
        try {
          await this.persistence.touchOrphanDraftReconciliation(draft.id);
        } catch (error) {
          this.logger.warn(
            `Could not update reconciliation cursor for draft ${draft.id}: ${this.errorMessage(error)}`,
          );
        }
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
