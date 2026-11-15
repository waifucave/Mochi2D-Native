/**
 * WAV files for motion sync: linear PCM with 8-bit unsigned or 16-, 24- or
 * 32-bit signed samples, and 32- or 64-bit float samples, also in the
 * extensible format; any channel count and rate. (Lip sync of the `LipSync`
 * group keeps the narrower reader of lip-sync.ts.)
 */
import type { MotionSyncSound } from "./driver.js";

/** Why a WAV file could not be read for motion sync. */
export class MotionSyncAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MotionSyncAudioError";
  }
}

const tag = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** The sample rates a WAV file for motion sync may have. */
const MIN_RATE = 1000;
const MAX_RATE = 768000;

/**
 * Decodes a WAV file into channels of samples in [−1, 1]. Throws a
 * {@link MotionSyncAudioError} for anything else, and for sample rates
 * outside 1–768 kHz.
 */
export function decodeMotionSyncWav(bytes: Uint8Array): MotionSyncSound {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE")
    throw new MotionSyncAudioError("not a RIFF/WAVE file");
  let o = 12;
  let format = -1;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let data: { start: number; size: number } | null = null;
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      format = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      // Extensible: the sub-format's first two bytes are the format code.
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.length)
        format = dv.getUint16(body + 24, true);
    } else if (id === "data") {
      data = { start: body, size: Math.min(size, bytes.length - body) };
      break;
    }
    o = body + size + (size & 1);
  }
  if (format < 0) throw new MotionSyncAudioError("no fmt chunk");
  if (!data) throw new MotionSyncAudioError("no data chunk");
  if (channels < 1 || !(rate > 0)) throw new MotionSyncAudioError("no channels, or no sample rate");
  // The analysis works on windows of the file's own rate: a rate far beyond audio's is a damaged file.
  if (rate < MIN_RATE || rate > MAX_RATE)
    throw new MotionSyncAudioError(
      `a sample rate of ${rate} Hz is outside ${MIN_RATE}–${MAX_RATE} Hz`,
    );
  const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
  const float = format === 3 && (bits === 32 || bits === 64);
  if (!pcm && !float)
    throw new MotionSyncAudioError(`format ${format} with ${bits}-bit samples is not supported`);
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const p = data.start + (i * channels + c) * bytesPer;
      let v: number;
      if (float) v = bits === 32 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      else if (bits === 8) v = (bytes[p]! - 128) / 128;
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24)
        v = (((bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16)) << 8) >> 8) / 8388608;
      else v = dv.getInt32(p, true) / 2147483648;
      out[c]![i] = v;
    }
  return { sampleRate: rate, channels: out };
}
