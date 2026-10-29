import { UnrecoverableError } from 'bullmq';
import { validateVideoProbe } from './video-probe';

describe('video processing media validation', () => {
  const validProbe = {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.25' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };

  it('accepts MP4 H.264 with AAC and records normalized metadata', () => {
    expect(validateVideoProbe(validProbe, 1234)).toEqual({
      durationSeconds: 3.25,
      metadata: {
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        width: 1920,
        height: 1080,
        size_bytes: 1234,
      },
    });
  });

  it('accepts MP4 H.264 without audio', () => {
    expect(
      validateVideoProbe(
        { ...validProbe, streams: [validProbe.streams[0]] },
        1234,
      ).metadata.audio_codec,
    ).toBeNull();
  });

  it.each([
    [
      'non-MP4 container',
      {
        ...validProbe,
        format: { ...validProbe.format, format_name: 'matroska' },
      },
    ],
    [
      'unsupported video codec',
      {
        ...validProbe,
        streams: [{ ...validProbe.streams[0], codec_name: 'hevc' }],
      },
    ],
    [
      'unsupported audio codec',
      {
        ...validProbe,
        streams: [
          validProbe.streams[0],
          { codec_type: 'audio', codec_name: 'opus' },
        ],
      },
    ],
    [
      'missing duration',
      { ...validProbe, format: { format_name: 'mp4', duration: 'N/A' } },
    ],
    ['missing video stream', { ...validProbe, streams: [] }],
  ])('rejects %s as permanent media error', (_case, probe) => {
    expect(() => validateVideoProbe(probe, 1234)).toThrow(UnrecoverableError);
  });
});
