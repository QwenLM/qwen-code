/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonLiveStatus } from '@qwen-code/sdk';
import {
  describeMicError,
  floatToPcm16,
  MICROPHONE_CONSTRAINTS,
  toVoiceWebSocketUrl,
  voiceWebSocketProtocols,
} from '../voice/capture-utils';
import { LIVE_OUTPUT_SAMPLE_RATE, PcmPlayer } from './pcm-player';

/**
 * Makes this page the Live Voice audio endpoint: it holds the daemon's single
 * Host lease over WS `/live/web`, streams the microphone up and plays the
 * model's speech. The call itself is still driven through `/live/*` (start,
 * stop, mute); this hook only moves audio and mirrors the pushed status.
 */
export const LIVE_WEB_HOST_PATH = '/live/web';
const LIVE_HOST_PROTOCOL_VERSION = 9;
const LIVE_WEB_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.web-shell';
const LIVE_INPUT_SAMPLE_RATE = 16_000;
// 64 ms per frame. Dictation uses 4096 (256 ms), which is fine for a
// transcript but far too laggy for a conversation.
const LIVE_INPUT_FRAME_SIZE = 1024;
const INPUT_EPOCH_BYTES = 8;
const OUTPUT_HEADER_BYTES = 16;
// Skip microphone frames rather than queue them behind a stalled socket: late
// audio is worse than missing audio in a live call.
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
// The daemon fails a call that receives audio before its realtime session is
// open, so nothing is sent while the call is still `starting`.
const STREAMING_STATES: ReadonlySet<DaemonLiveStatus['state']> = new Set([
  'listening',
  'thinking',
  'speaking',
]);

export type LiveBrowserHostPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export type LiveBrowserHostCloseReason =
  /** Another Host holds the lease (4009). `connect({ takeover })` may help. */
  | 'occupied'
  /** A native Host took over (4010). */
  | 'superseded-native'
  /** Another Web Shell tab took over (4010). */
  | 'superseded-tab'
  /** Live Voice is off, or the workspace is not trusted (4003). */
  | 'refused'
  | 'microphone'
  | 'lost';

export interface UseLiveBrowserHostOptions {
  baseUrl: string;
  token?: string;
  /** Status pushed by the daemon; fresher than polling `/live/status`. */
  onStatus?: (status: DaemonLiveStatus) => void;
}

export interface UseLiveBrowserHostResult {
  phase: LiveBrowserHostPhase;
  closeReason: LiveBrowserHostCloseReason | undefined;
  errorMessage: string | undefined;
  /** Must run inside a user gesture: it asks for the microphone. */
  connect: (options?: { takeover?: boolean }) => void;
  disconnect: () => void;
}

interface HostResources {
  ws?: WebSocket;
  stream?: MediaStream;
  capture?: AudioContext;
  playback?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  sink?: GainNode;
  player?: PcmPlayer;
}

function closeReasonFor(
  code: number,
  reason: string,
): LiveBrowserHostCloseReason {
  if (code === 4009) return 'occupied';
  if (code === 4010) {
    return /native/i.test(reason) ? 'superseded-native' : 'superseded-tab';
  }
  if (code === 4003) return 'refused';
  return 'lost';
}

function randomNonce(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useLiveBrowserHost({
  baseUrl,
  token,
  onStatus,
}: UseLiveBrowserHostOptions): UseLiveBrowserHostResult {
  const [phase, setPhase] = useState<LiveBrowserHostPhase>('idle');
  const [closeReason, setCloseReason] = useState<LiveBrowserHostCloseReason>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const phaseRef = useRef<LiveBrowserHostPhase>('idle');
  const generationRef = useRef(0);
  const resourcesRef = useRef<HostResources>({});
  const statusRef = useRef<DaemonLiveStatus>();
  const epochRef = useRef(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const applyPhase = useCallback((next: LiveBrowserHostPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const release = useCallback(() => {
    const resources = resourcesRef.current;
    resourcesRef.current = {};
    if (resources.processor) resources.processor.onaudioprocess = null;
    resources.processor?.disconnect();
    resources.source?.disconnect();
    resources.sink?.disconnect();
    resources.stream?.getTracks().forEach((track) => track.stop());
    resources.player?.clear();
    void resources.capture?.close().catch(() => undefined);
    void resources.playback?.close().catch(() => undefined);
    const ws = resources.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(1000);
      }
    }
    statusRef.current = undefined;
  }, []);

  const end = useCallback(
    (
      generation: number,
      next: LiveBrowserHostPhase,
      reason?: LiveBrowserHostCloseReason,
      message?: string,
    ) => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      release();
      setCloseReason(reason);
      setErrorMessage(message);
      applyPhase(next);
    },
    [applyPhase, release],
  );

  const disconnect = useCallback(() => {
    end(generationRef.current, 'idle');
  }, [end]);

  const connect = useCallback(
    (options: { takeover?: boolean } = {}) => {
      if (phaseRef.current === 'connecting' || phaseRef.current === 'connected')
        return;
      const generation = ++generationRef.current;
      const isCurrent = () => generationRef.current === generation;
      setCloseReason(undefined);
      setErrorMessage(undefined);
      applyPhase('connecting');

      if (!navigator.mediaDevices?.getUserMedia) {
        end(
          generation,
          'error',
          'microphone',
          window.isSecureContext
            ? 'Microphone capture is not supported in this browser.'
            : 'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.',
        );
        return;
      }

      // Both contexts are created synchronously, inside the user gesture that
      // called connect(); a context created later would start suspended.
      let capture: AudioContext;
      let playback: AudioContext;
      try {
        capture = new AudioContext({ sampleRate: LIVE_INPUT_SAMPLE_RATE });
        resourcesRef.current.capture = capture;
        playback = new AudioContext({ sampleRate: LIVE_OUTPUT_SAMPLE_RATE });
        resourcesRef.current.playback = playback;
        if (capture.sampleRate !== LIVE_INPUT_SAMPLE_RATE) {
          throw new Error(
            `Browser audio rate ${capture.sampleRate} Hz is not the required ${LIVE_INPUT_SAMPLE_RATE} Hz.`,
          );
        }
      } catch (error) {
        end(
          generation,
          'error',
          'microphone',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      void (async () => {
        let stream: MediaStream;
        try {
          [stream] = await Promise.all([
            navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS),
            capture.state === 'suspended' ? capture.resume() : undefined,
            playback.state === 'suspended' ? playback.resume() : undefined,
          ]);
        } catch (error) {
          end(generation, 'error', 'microphone', describeMicError(error));
          return;
        }
        if (!isCurrent()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        resourcesRef.current.stream = stream;

        const player = new PcmPlayer(playback);
        resourcesRef.current.player = player;
        const source = capture.createMediaStreamSource(stream);
        const processor = capture.createScriptProcessor(
          LIVE_INPUT_FRAME_SIZE,
          1,
          1,
        );
        // ScriptProcessor fires only while connected to a destination. A muted
        // gain node keeps the microphone out of the speakers.
        const sink = capture.createGain();
        sink.gain.value = 0;
        Object.assign(resourcesRef.current, { source, processor, sink });

        // Only now, with a working microphone, take the Host lease.
        const url = new URL(toVoiceWebSocketUrl(baseUrl, LIVE_WEB_HOST_PATH));
        if (options.takeover) url.searchParams.set('takeover', '1');
        const ws = new WebSocket(
          url.toString(),
          voiceWebSocketProtocols(token),
        );
        ws.binaryType = 'arraybuffer';
        resourcesRef.current.ws = ws;

        ws.onopen = () => {
          if (!isCurrent()) return;
          ws.send(
            JSON.stringify({
              type: 'host.hello',
              kind: 'browser',
              protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
              hostVersion: 'web-shell',
              bundleId: LIVE_WEB_HOST_BUNDLE_ID,
              instanceNonce: randomNonce(),
              permissions: { microphone: 'granted' },
              selfChecks: {
                audioInput: stream.getAudioTracks().length > 0,
                audioOutput: playback.state === 'running',
              },
            }),
          );
        };

        ws.onmessage = (event: MessageEvent) => {
          if (!isCurrent()) return;
          if (typeof event.data !== 'string') {
            const data = event.data as ArrayBuffer;
            if (data.byteLength <= OUTPUT_HEADER_BYTES) return;
            const epoch = Number(new DataView(data).getBigUint64(0));
            player.enqueue(epoch, data.slice(OUTPUT_HEADER_BYTES));
            return;
          }
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            return;
          }
          switch (message['type']) {
            case 'host.welcome':
            case 'host.state': {
              const status = message['status'] as DaemonLiveStatus | undefined;
              if (typeof message['epoch'] === 'number') {
                epochRef.current = message['epoch'];
              }
              if (status) {
                statusRef.current = status;
                player.setMuted(status.outputMuted === true);
                onStatusRef.current?.(status);
              }
              if (message['type'] === 'host.welcome') applyPhase('connected');
              return;
            }
            case 'host.ping':
              ws.send(
                JSON.stringify({
                  type: 'host.pong',
                  pingId: message['pingId'],
                }),
              );
              return;
            case 'host.clear_output':
              player.clear(
                typeof message['epoch'] === 'number'
                  ? message['epoch']
                  : undefined,
              );
              return;
            default:
              return;
          }
        };

        ws.onclose = (event: CloseEvent) => {
          const reason = closeReasonFor(event.code, event.reason);
          end(generation, 'error', reason, event.reason || undefined);
        };
        ws.onerror = () => {
          /* a close event always follows and carries the reason */
        };

        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
          const status = statusRef.current;
          if (
            !status ||
            status.inputMuted === true ||
            !STREAMING_STATES.has(status.state) ||
            ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
          ) {
            return;
          }
          const { pcm } = floatToPcm16(event.inputBuffer.getChannelData(0));
          const frame = new Uint8Array(INPUT_EPOCH_BYTES + pcm.byteLength);
          new DataView(frame.buffer).setBigUint64(0, BigInt(epochRef.current));
          frame.set(new Uint8Array(pcm), INPUT_EPOCH_BYTES);
          ws.send(frame.buffer);
        };
        source.connect(processor);
        processor.connect(sink);
        sink.connect(capture.destination);
      })();
    },
    [applyPhase, baseUrl, end, token],
  );

  useEffect(() => {
    const onPageHide = () => end(generationRef.current, 'idle');
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      generationRef.current += 1;
      release();
    };
  }, [end, release]);

  return { phase, closeReason, errorMessage, connect, disconnect };
}
