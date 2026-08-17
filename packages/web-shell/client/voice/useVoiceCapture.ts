/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Captures 16 kHz mono PCM in the browser and streams it to the immutable
 * workspace owner selected when recording starts. Credentials remain in the
 * browser-to-daemon transport; transcription stays server-side. The bearer
 * subprotocol is verified by the daemon's ACP upgrade listener in
 * `serve/acp-http/index.ts`.
 */
export type VoiceCaptureStatus =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface VoiceCaptureTarget {
  ownerKey: string;
  streamPath: string;
}

export interface VoiceUnexpectedClose {
  code: number;
  reason: string;
}

export interface UseVoiceCaptureOptions {
  baseUrl: string;
  token?: string;
  target: VoiceCaptureTarget | undefined;
  /** Called with the final transcript (may be empty). */
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onUnexpectedClose?: (event: VoiceUnexpectedClose) => void;
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
const START_TIMEOUT_MS = 60_000;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_BUFFERED_PCM_BYTES =
  SAMPLE_RATE * Int16Array.BYTES_PER_ELEMENT * (START_TIMEOUT_MS / 1000);

export function toVoiceWebSocketUrl(
  baseUrl: string,
  streamPath: string,
): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/?$/, '/');
  const url = new URL(
    streamPath.replace(/^\/+/, ''),
    `${base.origin}${basePath}`,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// Browsers cannot set Authorization on a WebSocket. The daemon decodes this
// bearer subprotocol during the upgrade; keep the prefix in sync with it.
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

interface CaptureSnapshot {
  generation: number;
  ownerKey: string;
  streamPath: string;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onUnexpectedClose?: (event: VoiceUnexpectedClose) => void;
}

export function useVoiceCapture({
  baseUrl,
  token,
  target,
  onFinal,
  onError,
  onUnexpectedClose,
}: UseVoiceCaptureOptions): UseVoiceCaptureReturn {
  const [status, setStatus] = useState<VoiceCaptureStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string>();

  const resourcesRef = useRef<CaptureResources>({});
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const stopWhenConnectedRef = useRef(false);
  const statusRef = useRef<VoiceCaptureStatus>('idle');
  const snapshotRef = useRef<CaptureSnapshot | undefined>(undefined);

  const applyStatus = useCallback((next: VoiceCaptureStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearTranscribeTimeout = useCallback(() => {
    const resources = resourcesRef.current;
    if (!resources.transcribeTimeout) return;
    clearTimeout(resources.transcribeTimeout);
    resources.transcribeTimeout = undefined;
  }, []);

  const teardownAudio = useCallback(() => {
    const resources = resourcesRef.current;
    if (resources.processor) resources.processor.onaudioprocess = null;
    for (const node of [
      resources.processor,
      resources.source,
      resources.sink,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // Best-effort browser resource cleanup.
      }
    }
    resources.stream?.getTracks().forEach((track) => track.stop());
    if (resources.context && resources.context.state !== 'closed') {
      void resources.context.close().catch(() => {});
    }
    resources.processor = undefined;
    resources.source = undefined;
    resources.sink = undefined;
    resources.stream = undefined;
    resources.context = undefined;
  }, []);

  const cleanup = useCallback(() => {
    generationRef.current++;
    snapshotRef.current = undefined;
    stopWhenConnectedRef.current = false;
    teardownAudio();
    clearTranscribeTimeout();
    const resources = resourcesRef.current;
    if (resources.ws) {
      try {
        resources.ws.onopen = null;
        resources.ws.onmessage = null;
        resources.ws.onerror = null;
        resources.ws.onclose = null;
        resources.ws.close();
      } catch {
        // Best-effort browser resource cleanup.
      }
      resources.ws = undefined;
    }
  }, [clearTranscribeTimeout, teardownAudio]);

  const snapshotIsCurrent = useCallback(
    (snapshot: CaptureSnapshot): boolean =>
      mountedRef.current &&
      generationRef.current === snapshot.generation &&
      snapshotRef.current === snapshot,
    [],
  );

  const fail = useCallback(
    (message: string, snapshot: CaptureSnapshot) => {
      if (!snapshotIsCurrent(snapshot)) return;
      cleanup();
      if (!mountedRef.current) return;
      applyStatus('error');
      setInterimText('');
      setAudioLevel(0);
      setErrorMessage(message);
      snapshot.onError?.(message);
    },
    [applyStatus, cleanup, snapshotIsCurrent],
  );

  const finishWith = useCallback(
    (text: string, snapshot: CaptureSnapshot) => {
      if (!snapshotIsCurrent(snapshot)) return;
      cleanup();
      if (!mountedRef.current) return;
      applyStatus('idle');
      setInterimText('');
      setAudioLevel(0);
      snapshot.onFinal(text);
    },
    [applyStatus, cleanup, snapshotIsCurrent],
  );

  const abort = useCallback(() => {
    const resources = resourcesRef.current;
    if (resources.ws?.readyState === WebSocket.OPEN) {
      try {
        resources.ws.send(JSON.stringify({ type: 'abort' }));
      } catch {
        // The socket may have closed between the readyState check and send.
      }
    }
    cleanup();
    if (!mountedRef.current) return;
    applyStatus('idle');
    setInterimText('');
    setAudioLevel(0);
    setErrorMessage(undefined);
  }, [applyStatus, cleanup]);

  const finalize = useCallback(
    (ws: WebSocket, snapshot: CaptureSnapshot) => {
      teardownAudio();
      setAudioLevel(0);
      applyStatus('transcribing');
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
        clearTranscribeTimeout();
        resourcesRef.current.transcribeTimeout = setTimeout(() => {
          if (
            snapshotIsCurrent(snapshot) &&
            statusRef.current === 'transcribing'
          ) {
            fail('Transcription timed out.', snapshot);
          }
        }, TRANSCRIPTION_TIMEOUT_MS);
      } catch {
        fail('Failed to finalize voice transcription.', snapshot);
      }
    },
    [
      applyStatus,
      clearTranscribeTimeout,
      fail,
      snapshotIsCurrent,
      teardownAudio,
    ],
  );

  const targetIdentity = target
    ? JSON.stringify([target.ownerKey, target.streamPath])
    : undefined;
  const previousTargetIdentityRef = useRef(targetIdentity);
  useLayoutEffect(() => {
    if (previousTargetIdentityRef.current === targetIdentity) return;
    previousTargetIdentityRef.current = targetIdentity;
    if (snapshotRef.current) abort();
    else {
      applyStatus('idle');
      setInterimText('');
      setAudioLevel(0);
      setErrorMessage(undefined);
    }
  }, [abort, applyStatus, targetIdentity]);

  const start = useCallback(() => {
    if (
      !target ||
      (statusRef.current !== 'idle' && statusRef.current !== 'error')
    ) {
      return;
    }

    setErrorMessage(undefined);
    setInterimText('');
    applyStatus('connecting');
    const snapshot: CaptureSnapshot = {
      generation: ++generationRef.current,
      ownerKey: target.ownerKey,
      streamPath: target.streamPath,
      onFinal,
      ...(onError ? { onError } : {}),
      ...(onUnexpectedClose ? { onUnexpectedClose } : {}),
    };
    snapshotRef.current = snapshot;

    if (!navigator.mediaDevices?.getUserMedia) {
      fail(
        window.isSecureContext
          ? 'Microphone capture is not supported in this browser.'
          : 'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.',
        snapshot,
      );
      return;
    }

    let context: AudioContext;
    let contextReady: Promise<void>;
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      resourcesRef.current.context = context;
      if (context.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `Browser audio rate ${context.sampleRate} Hz is not the required ${SAMPLE_RATE} Hz.`,
        );
      }
      contextReady =
        context.state === 'suspended' ? context.resume() : Promise.resolve();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), snapshot);
      return;
    }

    clearTranscribeTimeout();
    resourcesRef.current.transcribeTimeout = setTimeout(() => {
      if (snapshotIsCurrent(snapshot) && statusRef.current === 'connecting') {
        fail('Voice capture timed out while starting.', snapshot);
      }
    }, START_TIMEOUT_MS);

    void (async () => {
      try {
        const streamPromise = navigator.mediaDevices
          .getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
            },
          })
          .then(
            (stream) => {
              if (!snapshotIsCurrent(snapshot)) {
                stream.getTracks().forEach((track) => track.stop());
              } else {
                resourcesRef.current.stream = stream;
              }
              return stream;
            },
            (error: unknown) => {
              throw new Error(describeMicError(error));
            },
          );
        const [stream] = await Promise.all([streamPromise, contextReady]);
        if (!snapshotIsCurrent(snapshot)) return;

        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
        // ScriptProcessor fires only while connected to a destination. A muted
        // gain node keeps the microphone out of the speakers.
        const sink = context.createGain();
        sink.gain.value = 0;
        resourcesRef.current.source = source;
        resourcesRef.current.processor = processor;
        resourcesRef.current.sink = sink;

        const ws = new WebSocket(
          toVoiceWebSocketUrl(baseUrl, snapshot.streamPath),
          token ? [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)] : undefined,
        );
        ws.binaryType = 'arraybuffer';
        resourcesRef.current.ws = ws;
        const bufferedPcm: ArrayBuffer[] = [];
        let bufferedPcmBytes = 0;
        let streamStarted = false;

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          if (!snapshotIsCurrent(snapshot)) return;
          const { pcm, level } = floatToPcm16(
            event.inputBuffer.getChannelData(0),
          );
          setAudioLevel(level);
          if (streamStarted) {
            if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
          } else {
            if (bufferedPcmBytes + pcm.byteLength > MAX_BUFFERED_PCM_BYTES) {
              fail(
                'Voice capture buffer limit reached while starting.',
                snapshot,
              );
              return;
            }
            bufferedPcm.push(pcm);
            bufferedPcmBytes += pcm.byteLength;
          }
        };
        if (!stopWhenConnectedRef.current) {
          source.connect(processor);
          processor.connect(sink);
          sink.connect(context.destination);
        }

        ws.onopen = () => {
          if (!snapshotIsCurrent(snapshot)) {
            try {
              ws.close();
            } catch {
              // The stale socket may already be closed.
            }
            return;
          }
          ws.send(JSON.stringify({ type: 'start' }));
          streamStarted = true;
          for (const pcm of bufferedPcm) ws.send(pcm);
          bufferedPcm.length = 0;
          bufferedPcmBytes = 0;
          clearTranscribeTimeout();
          if (stopWhenConnectedRef.current) {
            stopWhenConnectedRef.current = false;
            finalize(ws, snapshot);
            return;
          }
          resourcesRef.current.transcribeTimeout = setTimeout(() => {
            if (
              snapshotIsCurrent(snapshot) &&
              statusRef.current === 'recording'
            ) {
              fail(
                'No response from server. Check that the voice model is running.',
                snapshot,
              );
            }
          }, TRANSCRIPTION_TIMEOUT_MS);
          applyStatus('recording');
        };

        ws.onmessage = (event: MessageEvent) => {
          if (!snapshotIsCurrent(snapshot)) return;
          if (
            statusRef.current === 'connecting' ||
            statusRef.current === 'recording'
          ) {
            clearTranscribeTimeout();
          }
          let message: { type?: string; text?: string; message?: string };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.type === 'interim') {
            setInterimText(message.text ?? '');
          } else if (message.type === 'final') {
            finishWith(message.text ?? '', snapshot);
          } else if (message.type === 'error') {
            fail(
              message.message ?? message.text ?? 'Voice transcription failed.',
              snapshot,
            );
          }
        };

        ws.onerror = () => {
          // The close event carries the useful code and reason.
        };
        ws.onclose = (event) => {
          // A close before a final result is never successful completion.
          if (
            !snapshotIsCurrent(snapshot) ||
            !(
              statusRef.current === 'recording' ||
              statusRef.current === 'connecting' ||
              statusRef.current === 'transcribing'
            )
          ) {
            return;
          }
          const code = event.code || 1006;
          const reason = event.reason || 'none';
          try {
            snapshot.onUnexpectedClose?.({ code, reason });
          } catch {
            // An observer must not prevent capture cleanup.
          }
          fail(
            code === 1013
              ? reason === 'none'
                ? 'Voice capacity is temporarily unavailable. Retry shortly.'
                : reason
              : `Voice connection closed (code=${code}, reason=${reason}).`,
            snapshot,
          );
        };
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), snapshot);
      }
    })();
  }, [
    applyStatus,
    baseUrl,
    clearTranscribeTimeout,
    fail,
    finalize,
    finishWith,
    onError,
    onFinal,
    onUnexpectedClose,
    snapshotIsCurrent,
    target,
    token,
  ]);

  const stop = useCallback(() => {
    const snapshot = snapshotRef.current;
    const ws = resourcesRef.current.ws;
    if (!snapshot || !ws || ws.readyState !== WebSocket.OPEN) {
      if (snapshot && statusRef.current === 'connecting') {
        if (resourcesRef.current.processor) teardownAudio();
        stopWhenConnectedRef.current = true;
        clearTranscribeTimeout();
        return;
      }
      abort();
      return;
    }
    if (statusRef.current === 'transcribing') return;
    finalize(ws, snapshot);
  }, [abort, clearTranscribeTimeout, finalize, teardownAudio]);

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
