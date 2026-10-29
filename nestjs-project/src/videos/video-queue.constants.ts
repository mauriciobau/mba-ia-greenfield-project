export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_QUEUE_CLIENT = Symbol(
  'VIDEO_PROCESSING_QUEUE_CLIENT',
);
export const VIDEO_PROCESSING_JOB = 'video.process.requested';
export const VIDEO_PROCESSING_ATTEMPTS = 3;
export const VIDEO_PROCESSING_BACKOFF_MS = 5_000;
export const VIDEO_PROCESSING_CONCURRENCY = 1;
export const VIDEO_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
export const VIDEO_PROCESSING_RECONCILIATION_MS = 30_000;
export const VIDEO_PROCESSING_RECONCILIATION_GRACE_MS = 60_000;
export const VIDEO_PROCESSING_EXECUTION_LEASE_MS = 60_000;
export const VIDEO_PROCESSING_EXECUTION_HEARTBEAT_MS = 15_000;
export const VIDEO_PROCESSING_MAX_RECOVERIES = 3;

export interface VideoProcessingJobData {
  eventId: string;
  videoId: string;
  generation: number;
}

export function videoProcessingJobId(
  videoId: string,
  generation: number,
): string {
  return `video-${videoId}-${generation}`;
}
