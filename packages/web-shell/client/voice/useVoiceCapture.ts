/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Browser-side voice capture for the Web Shell. Captures the microphone via
 * `getUserMedia`, downsamples to 16 kHz mono s16le PCM in an AudioWorklet, and
 * streams the raw frames to the daemon's `/voice/stream` WebSocket. The daemon
 * transcribes server-side (credentials never reach the browser) and returns
 * interim/final transcripts.
 *
 * Note: browsers cannot set an `Authorization` header on a WebSocket. When a
 * bearer token is configured it rides in the `Sec-WebSocket-Protocol`
 * subprotocol as `qwen-bearer.<base64url(token)>` (see `bearerSubprotocol`),
 * which the daemon's ACP upgrade listener verifies — so this works against both
 * no-token loopback and token-required deployments.
 */
export type VoiceCaptureStatus =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface UseVoiceCaptureOptions {
  baseUrl: string;
  token?: string;
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

function toWebSocketUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/?$/, '/');
  const url = new URL('voice/stream', `${base.origin}${basePath}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Browsers can't set an `Authorization` header on a WebSocket, so the bearer
 * token rides in `Sec-WebSocket-Protocol` as `qwen-bearer.<base64url(token)>`.
 * The daemon's ACP upgrade listener decodes it (serve/acp-http/index.ts) — keep
 * this prefix in sync with `WS_BEARER_SUBPROTOCOL_PREFIX` there.
 */
const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';
// Non-secret marker offered alongside the bearer subprotocol. The daemon
// completes the handshake by selecting THIS (never echoing the secret), which
// also satisfies WS clients that require the server to pick an offered
// subprotocol when any were requested. Must not start with the bearer prefix.
const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

function bearerSubprotocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${WS_BEARER_SUBPROTOCOL_PREFIX}${b64}`;
}

/** Turn a getUserMedia rejection into an actionable, human message. */
function describeMicError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone blocked. Click the camera/lock icon in the address bar to allow the mic for this site, and enable your browser under System Settings → Privacy → Microphone, then retry.';
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
function floatToPcm16(input: Float32Array): {
  pcm: ArrayBuffer;
  level: number;
} {
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

interface CaptureResources {
  ws?: WebSocket;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  // ScriptProcessorNode (not AudioWorklet): the Web Shell CSP `script-src`
  // omits `blob:`, which blocks a Blob-URL worklet module. ScriptProcessor
  // needs no module load, so it sidesteps CSP entirely.
  processor?: ScriptProcessorNode;
  sink?: GainNode;
  transcribeTimeout?: ReturnType<typeof setTimeout>;
}

export function useVoiceCapture(
  options: UseVoiceCaptureOptions,
): UseVoiceCaptureReturn {
  const { baseUrl, token, onFinal, onError } = options;

  const [status, setStatus] = useState<VoiceCaptureStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(
    undefined,
  );

  const resourcesRef = useRef<CaptureResources>({});
  const mountedRef = useRef(true);
  const captureGenerationRef = useRef(0);
  // Live status for async WS/worklet callbacks, which would otherwise read a
  // stale closure copy of `status`.
  const statusRef = useRef<VoiceCaptureStatus>('idle');
  // Latest callbacks without re-binding the capture lifecycle.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const applyStatus = useCallback((next: VoiceCaptureStatus) => {
    statusRef.current = next;
    setStatus(next);
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
    if (res.transcribeTimeout) {
      clearTimeout(res.transcribeTimeout);
      res.transcribeTimeout = undefined;
    }
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
  }, [teardownAudio]);

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

  const start = useCallback(() => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return;
    setErrorMessage(undefined);
    setInterimText('');
    applyStatus('connecting');
    const generation = ++captureGenerationRef.current;
    const isStale = () =>
      !mountedRef.current || captureGenerationRef.current !== generation;

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            window.isSecureContext
              ? 'Microphone capture is not supported in this browser.'
              : 'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.',
          );
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
        if (context.sampleRate !== SAMPLE_RATE) {
          stream.getTracks().forEach((track) => track.stop());
          void context.close().catch(() => {});
          throw new Error(
            `Browser audio rate ${context.sampleRate} Hz is not the required ${SAMPLE_RATE} Hz.`,
          );
        }
        resourcesRef.current.context = context;
        // Resume in case the browser created it suspended (pre-gesture).
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

        const ws = new WebSocket(
          toWebSocketUrl(baseUrl),
          token ? [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)] : undefined,
        );
        ws.binaryType = 'arraybuffer';
        resourcesRef.current.ws = ws;

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          const { pcm, level } = floatToPcm16(
            event.inputBuffer.getChannelData(0),
          );
          if (mountedRef.current) setAudioLevel(level);
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
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
          if (mountedRef.current) applyStatus('recording');
        };

        ws.onmessage = (event: MessageEvent) => {
          let msg: { type?: string; text?: string; message?: string };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.type === 'interim') {
            if (mountedRef.current) setInterimText(msg.text ?? '');
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
          // A close before a final result (and not during normal teardown)
          // surfaces as an error so the user isn't left stuck.
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
  }, [baseUrl, token, fail, finishWith, applyStatus]);

  const stop = useCallback(() => {
    const ws = resourcesRef.current.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cleanup();
      applyStatus('idle');
      return;
    }
    // Stop feeding audio, then ask the daemon to finalize. The 'final' frame
    // resolves the transcript; teardownAudio releases the mic immediately.
    teardownAudio();
    setAudioLevel(0);
    applyStatus('transcribing');
    const generation = captureGenerationRef.current;
    try {
      ws.send(JSON.stringify({ type: 'stop' }));
      resourcesRef.current.transcribeTimeout = setTimeout(() => {
        if (statusRef.current === 'transcribing') {
          fail('Transcription timed out.', generation);
        }
      }, TRANSCRIPTION_TIMEOUT_MS);
    } catch {
      fail('Failed to finalize voice transcription.');
    }
  }, [cleanup, teardownAudio, fail, applyStatus]);

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
