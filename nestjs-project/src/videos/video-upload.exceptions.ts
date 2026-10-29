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

export class VideoUploadNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video upload was not found');
  }
}

export class VideoUploadConflictException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_CONFLICT', 409, 'Video upload is no longer active');
  }
}

export class VideoUploadInvalidPartsException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_INVALID_PARTS', 400, 'Requested parts are invalid');
  }
}
