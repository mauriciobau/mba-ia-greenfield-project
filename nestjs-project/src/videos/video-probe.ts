import { UnrecoverableError } from 'bullmq';

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

export interface ProbeResult {
  format?: { format_name?: string; duration?: string; size?: string };
  streams?: ProbeStream[];
}

export function validateVideoProbe(
  probe: ProbeResult,
  size: number,
): { durationSeconds: number; metadata: Record<string, unknown> } {
  const formatName = probe.format?.format_name ?? '';
  const streams = probe.streams ?? [];
  const videoStreams = streams.filter(
    (stream) => stream.codec_type === 'video',
  );
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === 'audio',
  );
  const video = videoStreams[0];
  const durationSeconds = Number(probe.format?.duration);
  if (
    !formatName.split(',').includes('mp4') ||
    videoStreams.length !== 1 ||
    video?.codec_name !== 'h264' ||
    audioStreams.some((stream) => stream.codec_name !== 'aac') ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !video.width ||
    !video.height
  ) {
    throw new UnrecoverableError(
      'Video must be MP4 with H.264 and optional AAC audio',
    );
  }
  return {
    durationSeconds,
    metadata: {
      container: 'mp4',
      video_codec: 'h264',
      audio_codec: audioStreams[0]?.codec_name ?? null,
      width: video.width,
      height: video.height,
      size_bytes: size,
    },
  };
}
