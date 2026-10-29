import { DomainException } from '../common/exceptions/domain.exception';

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_TOO_LARGE',
      413,
      'Video upload exceeds the maximum allowed size',
    );
  }
}

export class VideoStorageUnavailableException extends DomainException {
  constructor() {
    super(
      'VIDEO_STORAGE_UNAVAILABLE',
      503,
      'Video storage is temporarily unavailable',
    );
  }
}

export class VideoChannelNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_CHANNEL_NOT_FOUND', 404, 'Video channel was not found');
  }
}
