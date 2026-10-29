export const S3_CLIENT = Symbol('S3_CLIENT');

export const VIDEO_UPLOAD = {
  MAX_SIZE_BYTES: 10_000_000_000,
  PART_SIZE_BYTES: 64 * 1024 * 1024,
  EXPIRATION_MS: 24 * 60 * 60 * 1000,
  CONTENT_TYPE: 'video/mp4',
} as const;
