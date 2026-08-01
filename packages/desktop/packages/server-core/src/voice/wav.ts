/**
 * Wrap raw PCM in a WAV container for the batch transcription endpoint.
 *
 * Browser capture streams raw s16le / 16 kHz / mono PCM frames; the Qwen-ASR
 * batch path (non-streaming) wants a WAV file, so the daemon-side accumulates
 * the frames and prepends a 44-byte header before posting.
 */

/** PCM capture format shared with the renderer (useVoiceCapture). */
export const VOICE_SAMPLE_RATE = 16_000;

export function encodeWav(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  const dataLen = pcm.byteLength;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  header.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
