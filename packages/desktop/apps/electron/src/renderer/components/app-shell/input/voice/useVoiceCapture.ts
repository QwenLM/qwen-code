/**
 * Renderer-side voice capture for the desktop composer. Captures the microphone
 * via `getUserMedia`, resamples to 16 kHz mono s16le PCM in a ScriptProcessor,
 * and streams the raw frames to the main process's loopback `/voice/stream`
 * WebSocket. Transcription runs in the main process (credentials never reach the
 * renderer) and the final transcript comes back for the user to review.
 *
 * Adapted from the Web Shell hook (packages/web-shell/client/voice/useVoiceCapture.ts);
 * the desktop receives a ready-to-use ws url (token in the query) from the
 * preload, so there is no bearer-subprotocol handshake here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { sendVoicePcmFrame } from './voice-frame-sender';

export type VoiceCaptureStatus =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface UseVoiceCaptureOptions {
  /** Full ws url (with token) from electronAPI.getVoiceStreamUrl(); null disables. */
  wsUrl: string | null;
  /** Called with the final transcript (may be empty). */
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
}

export interface UseVoiceCaptureReturn {
  status: VoiceCaptureStatus;
  interimText: string;
  /** Recent input level, 0..1, for a live meter. */
  audioLevel: number;
  errorMessage: string | undefined;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

const SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** Turn a getUserMedia rejection into an actionable, human message. */
function describeMicError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone blocked. Allow microphone access for Qwen Code in your system privacy settings, then retry.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one and retry.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Microphone is in use by another app. Close it and retry.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/** Float32 [-1,1] frame → Int16 PCM + RMS level. */
function floatToPcm16(input: Float32Array): { pcm: ArrayBuffer; level: number } {
  const pcm = new Int16Array(input.length);
  let sumSquares = 0;
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    sumSquares += s * s;
  }
  return {
    pcm: pcm.buffer,
    level: input.length ? Math.sqrt(sumSquares / input.length) : 0,
  };
}

export function resampleToSampleRate(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = SAMPLE_RATE,
): Float32Array {
  if (inputSampleRate === outputSampleRate) return input;
  const outputLength = Math.max(
    1,
    Math.round((input.length * outputSampleRate) / inputSampleRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / outputSampleRate;

  for (let i = 0; i < output.length; i++) {
    const sourceIndex = i * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, input.length - 1);
    const frac = sourceIndex - low;
    output[i] = input[low]! + (input[high]! - input[low]!) * frac;
  }

  return output;
}

interface CaptureResources {
  ws?: WebSocket;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  sink?: GainNode;
  transcribeTimeout?: ReturnType<typeof setTimeout>;
}

export function useVoiceCapture(
  options: UseVoiceCaptureOptions,
): UseVoiceCaptureReturn {
  const { wsUrl, onFinal, onError } = options;

  const [status, setStatus] = useState<VoiceCaptureStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(
    undefined,
  );

  const resourcesRef = useRef<CaptureResources>({});
  const mountedRef = useRef(true);
  const captureGenerationRef = useRef(0);
  // Live status for async WS/processor callbacks, which would otherwise read a
  // stale closure copy of `status`.
  const statusRef = useRef<VoiceCaptureStatus>('idle');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const applyStatus = useCallback((next: VoiceCaptureStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearTranscribeTimeout = useCallback(() => {
    const res = resourcesRef.current;
    if (res.transcribeTimeout) {
      clearTimeout(res.transcribeTimeout);
      res.transcribeTimeout = undefined;
    }
  }, []);

  const teardownAudio = useCallback(() => {
    const res = resourcesRef.current;
    if (res.processor) res.processor.onaudioprocess = null;
    for (const node of [res.processor, res.source, res.sink]) {
      try {
        node?.disconnect();
      } catch {
        /* ignore */
      }
    }
    res.stream?.getTracks().forEach((track) => track.stop());
    if (res.context && res.context.state !== 'closed') {
      void res.context.close().catch(() => {});
    }
    res.processor = undefined;
    res.sink = undefined;
    res.source = undefined;
    res.stream = undefined;
    res.context = undefined;
  }, []);

  const cleanup = useCallback(() => {
    captureGenerationRef.current++;
    teardownAudio();
    const res = resourcesRef.current;
    clearTranscribeTimeout();
    if (res.ws) {
      try {
        res.ws.onmessage = null;
        res.ws.onerror = null;
        res.ws.onclose = null;
        res.ws.close();
      } catch {
        /* ignore */
      }
      res.ws = undefined;
    }
  }, [teardownAudio, clearTranscribeTimeout]);

  const fail = useCallback(
    (message: string, generation?: number) => {
      if (
        !mountedRef.current ||
        (generation !== undefined &&
          captureGenerationRef.current !== generation)
      ) {
        return;
      }
      cleanup();
      applyStatus('error');
      setInterimText('');
      setAudioLevel(0);
      setErrorMessage(message);
      onErrorRef.current?.(message);
    },
    [cleanup, applyStatus],
  );

  const finishWith = useCallback(
    (text: string, generation?: number) => {
      if (
        generation !== undefined &&
        captureGenerationRef.current !== generation
      ) {
        return;
      }
      cleanup();
      if (!mountedRef.current) return;
      applyStatus('idle');
      setInterimText('');
      setAudioLevel(0);
      onFinalRef.current(text);
    },
    [cleanup, applyStatus],
  );

  const armTranscribeTimeout = useCallback(
    (generation: number) => {
      clearTranscribeTimeout();
      resourcesRef.current.transcribeTimeout = setTimeout(() => {
        if (statusRef.current === 'recording') {
          fail(
            'No response from server. Check that the voice model is running.',
            generation,
          );
        }
      }, TRANSCRIPTION_TIMEOUT_MS);
    },
    [clearTranscribeTimeout, fail],
  );

  const start = useCallback(() => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return;
    if (!wsUrl) {
      fail('Voice dictation is unavailable.');
      return;
    }
    setErrorMessage(undefined);
    setInterimText('');
    applyStatus('connecting');
    const generation = ++captureGenerationRef.current;
    const isStale = () =>
      !mountedRef.current || captureGenerationRef.current !== generation;

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone capture is not supported here.');
        }
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
            },
          });
        } catch (err) {
          throw new Error(describeMicError(err));
        }
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        resourcesRef.current.stream = stream;

        const context = new AudioContext({ sampleRate: SAMPLE_RATE });
        resourcesRef.current.context = context;
        if (context.state === 'suspended') await context.resume();
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          void context.close().catch(() => {});
          return;
        }

        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
        // Silent sink: a ScriptProcessorNode only fires `onaudioprocess` while
        // connected to the destination; gain 0 avoids routing mic to speakers.
        const sink = context.createGain();
        sink.gain.value = 0;
        resourcesRef.current.source = source;
        resourcesRef.current.processor = processor;
        resourcesRef.current.sink = sink;

        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        resourcesRef.current.ws = ws;

        let lastLevelUpdate = 0;
        let droppedFrames = 0;
        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          const input = resampleToSampleRate(
            event.inputBuffer.getChannelData(0),
            context.sampleRate,
          );
          const { pcm, level } = floatToPcm16(input);
          const now = performance.now();
          if (mountedRef.current && now - lastLevelUpdate >= 100) {
            lastLevelUpdate = now;
            setAudioLevel(level);
          }
          droppedFrames = sendVoicePcmFrame(ws, pcm, droppedFrames, () =>
            fail('Voice connection lost. Audio is not being sent.', generation),
          );
        };

        ws.onopen = () => {
          if (isStale()) {
            processor.onaudioprocess = null;
            for (const node of [processor, source, sink]) {
              try {
                node.disconnect();
              } catch {
                /* ignore */
              }
            }
            stream.getTracks().forEach((track) => track.stop());
            if (context.state !== 'closed') {
              void context.close().catch(() => {});
            }
            const res = resourcesRef.current;
            if (res.ws === ws) res.ws = undefined;
            if (res.processor === processor) res.processor = undefined;
            if (res.source === source) res.source = undefined;
            if (res.sink === sink) res.sink = undefined;
            if (res.stream === stream) res.stream = undefined;
            if (res.context === context) res.context = undefined;
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          ws.send(JSON.stringify({ type: 'start' }));
          source.connect(processor);
          processor.connect(sink);
          sink.connect(context.destination);
          armTranscribeTimeout(generation);
          if (mountedRef.current) applyStatus('recording');
        };

        ws.onmessage = (event: MessageEvent) => {
          let msg: {
            type?: string;
            text?: string;
            message?: string;
            streaming?: boolean;
          };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.type === 'ready') {
            if (msg.streaming === false) {
              clearTranscribeTimeout();
            } else if (statusRef.current === 'recording') {
              armTranscribeTimeout(generation);
            }
          } else if (msg.type === 'interim') {
            if (mountedRef.current) setInterimText(msg.text ?? '');
            if (statusRef.current === 'recording') {
              armTranscribeTimeout(generation);
            }
          } else if (msg.type === 'final') {
            finishWith(msg.text ?? '', generation);
          } else if (msg.type === 'error') {
            fail(
              msg.message ?? msg.text ?? 'Voice transcription failed.',
              generation,
            );
          }
        };

        ws.onerror = () => {
          // The following close event carries the useful code/reason.
        };
        ws.onclose = (event) => {
          // The server closes 1000 only on normal completion ('done' after the
          // final transcript, or 'aborted'); errors use 1011/1013 and drops are
          // 1006. A graceful 1000 normally arrives after the `final` message has
          // already detached this handler, but guard the code here too so a bare
          // 1000 close can't surface a normal finish as a spurious error.
          if (event.code === 1000) return;
          if (
            mountedRef.current &&
            (statusRef.current === 'recording' ||
              statusRef.current === 'connecting' ||
              statusRef.current === 'transcribing')
          ) {
            const code = event.code || 1006;
            const reason = event.reason || 'none';
            fail(
              `Voice connection closed (code=${code}, reason=${reason}).`,
              generation,
            );
          }
        };
      } catch (error) {
        fail(
          error instanceof Error ? error.message : String(error),
          generation,
        );
      }
    })();
  }, [
    wsUrl,
    fail,
    finishWith,
    applyStatus,
    armTranscribeTimeout,
    clearTranscribeTimeout,
  ]);

  const stop = useCallback(() => {
    const ws = resourcesRef.current.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cleanup();
      applyStatus('idle');
      return;
    }
    // Stop feeding audio, then ask the server to finalize. The 'final' frame
    // resolves the transcript; teardownAudio releases the mic immediately.
    teardownAudio();
    setAudioLevel(0);
    applyStatus('transcribing');
    const generation = captureGenerationRef.current;
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
      clearTranscribeTimeout();
      resourcesRef.current.transcribeTimeout = setTimeout(() => {
        if (statusRef.current === 'transcribing') {
          fail('Transcription timed out.', generation);
        }
      }, TRANSCRIPTION_TIMEOUT_MS);
    } catch {
      fail('Failed to finalize voice transcription.', generation);
    }
  }, [cleanup, teardownAudio, fail, applyStatus, clearTranscribeTimeout]);

  const abort = useCallback(() => {
    const ws = resourcesRef.current.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'abort' }));
      } catch {
        /* ignore */
      }
    }
    cleanup();
    applyStatus('idle');
    setInterimText('');
    setAudioLevel(0);
  }, [cleanup, applyStatus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  return {
    status,
    interimText,
    audioLevel,
    errorMessage,
    start,
    stop,
    abort,
  };
}
