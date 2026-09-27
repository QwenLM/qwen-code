/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { DaemonLiveStatus } from '@qwen-code/sdk';
import {
  describeMicError,
  floatToPcm16,
  MICROPHONE_CONSTRAINTS,
  toVoiceWebSocketUrl,
  voiceWebSocketProtocols,
} from '../voice/capture-utils';
import { LIVE_OUTPUT_SAMPLE_RATE, PcmPlayer } from './pcm-player';
import {
  canShareScreen,
  startScreenShare,
  type LiveScreenShareHandle,
} from './screen-share';
import { sampleScreen } from './screen-feed-sampler';
// Emitted as a same-origin asset by the app build, which the Web Shell CSP
// (`script-src 'self'`) lets `audioWorklet.addModule()` load.
import captureWorkletUrl from './capture-worklet.js?url';

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
// `bufferedAmount` hovering around the limit would flip the dropping flag on
// every 64 ms frame. Reported state holds for this long after the last frame
// actually dropped, so it changes a couple of times a second at most.
const DROPPING_HOLD_MS = 500;
// The daemon fails a call that receives audio before its realtime session is
// open, so nothing is sent while the call is still `starting`.
const STREAMING_STATES: ReadonlySet<DaemonLiveStatus['state']> = new Set([
  'listening',
  'thinking',
  'speaking',
]);

/**
 * What the capture callback last saw. `at` is the `performance.now()` of that
 * frame: a meter that only kept the level would go on showing the last value
 * after the callback stops firing (a suspended AudioContext, a device change),
 * which is exactly when it is being looked at.
 */
export interface LiveInputLevel {
  /** RMS of the frame, 0..1. Zero while input is muted. */
  level: number;
  at: number;
  /**
   * The call is running but frames are not being sent: the socket is backed
   * up. The microphone is fine and the daemon is still not hearing it. Held
   * for a moment after the last dropped frame, so it does not flicker.
   */
  dropping: boolean;
}

const SILENT_INPUT: LiveInputLevel = { level: 0, at: 0, dropping: false };

const CAPTURE_WORKLET_PROCESSOR = 'qwen-live-capture';

/**
 * `worklet`: microphone frames are produced, converted and measured on the
 * audio rendering thread. `script-processor`: the deprecated main-thread
 * node, kept as the fallback for wherever the worklet module cannot be
 * loaded — a browser without AudioWorklet, or an embedding whose library build
 * inlines the module as a `data:` URL the CSP refuses.
 */
export type LiveCaptureMode = 'worklet' | 'script-processor';

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
  /** How the microphone is being captured; undefined until connected. */
  captureMode: LiveCaptureMode | undefined;
  /**
   * Most recent microphone frame, for a meter. A ref rather than state:
   * at 64 ms frames this changes ~16 times a second, and re-rendering the
   * dialog that often would steal the main thread from the very
   * ScriptProcessor callback that produces the audio.
   */
  inputLevel: RefObject<LiveInputLevel>;
  /** Must run inside a user gesture: it asks for the microphone. */
  connect: (options?: { takeover?: boolean }) => void;
  disconnect: () => void;
  /** What the model can see, and when it last looked. */
  screenShare: LiveScreenShareState;
  /** Must run inside a user gesture: it asks which screen to share. */
  startSharingScreen: () => Promise<void>;
  stopSharingScreen: () => void;
  screenFeed: LiveScreenFeedState;
}

export interface LiveScreenFeedState {
  supported: boolean;
  feedId?: string;
  phase: 'idle' | 'starting' | 'streaming' | 'stopped' | 'error';
  message?: string;
}

export interface LiveScreenShareState {
  /** False where `getDisplayMedia` is unavailable, so the share is never offered. */
  supported: boolean;
  sharing: boolean;
  /** The track's own name for what is shared, e.g. a window title. */
  label: string | undefined;
  errorMessage: string | undefined;
  /** `performance.now()` of the last frame the model was given, for the UI. */
  lastLookAt: number | undefined;
  /** The model asked while nothing was shared, so the UI can offer to start. */
  requestedWhileIdle: boolean;
}

interface HostResources {
  ws?: WebSocket;
  stream?: MediaStream;
  capture?: AudioContext;
  playback?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  worklet?: AudioWorkletNode;
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

function describeShareError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Screen sharing was not allowed.';
  }
  return error instanceof Error && error.message
    ? error.message
    : 'The screen could not be captured.';
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
  const [captureMode, setCaptureMode] = useState<LiveCaptureMode>();
  const [screenShare, setScreenShare] = useState<LiveScreenShareState>(() => ({
    supported: canShareScreen(),
    sharing: false,
    label: undefined,
    errorMessage: undefined,
    lastLookAt: undefined,
    requestedWhileIdle: false,
  }));
  const [screenFeed, setScreenFeed] = useState<LiveScreenFeedState>({
    supported: false,
    phase: 'idle',
  });
  const feedSupportedRef = useRef(false);
  const feedAttemptRef = useRef<string | undefined>(undefined);
  const feedRef = useRef<
    { id: string; epoch: number; cancel?: () => void } | undefined
  >(undefined);
  const shareGenerationRef = useRef(0);
  const shareRef = useRef<LiveScreenShareHandle | undefined>(undefined);

  const phaseRef = useRef<LiveBrowserHostPhase>('idle');
  const generationRef = useRef(0);
  const resourcesRef = useRef<HostResources>({});
  const statusRef = useRef<DaemonLiveStatus | undefined>(undefined);
  const epochRef = useRef(0);
  const inputLevelRef = useRef<LiveInputLevel>(SILENT_INPUT);
  const droppingUntilRef = useRef(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const applyPhase = useCallback((next: LiveBrowserHostPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopScreenFeed = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.cancel?.();
    feedRef.current = undefined;
    const ws = resourcesRef.current.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'host.screen_feed_stop',
          epoch: feed.epoch,
          feedId: feed.id,
        }),
      );
    }
    setScreenFeed((previous) => ({
      ...previous,
      phase: 'stopped',
      message: undefined,
    }));
  }, []);

  const startScreenFeed = useCallback(() => {
    const ws = resourcesRef.current.ws;
    const status = statusRef.current;
    const attempt = `${epochRef.current}:${shareGenerationRef.current}`;
    if (
      !feedSupportedRef.current ||
      !shareRef.current ||
      !status ||
      !STREAMING_STATES.has(status.state) ||
      ws?.readyState !== WebSocket.OPEN ||
      feedAttemptRef.current === attempt
    )
      return;
    stopScreenFeed();
    feedAttemptRef.current = attempt;
    const feed = { id: randomNonce(), epoch: epochRef.current };
    feedRef.current = feed;
    setScreenFeed({ supported: true, phase: 'starting', feedId: feed.id });
    ws.send(
      JSON.stringify({
        type: 'host.screen_feed_start',
        epoch: feed.epoch,
        feedId: feed.id,
      }),
    );
  }, [stopScreenFeed]);

  const stopSharingScreen = useCallback(() => {
    shareGenerationRef.current += 1;
    stopScreenFeed();
    shareRef.current?.stop();
    shareRef.current = undefined;
    setScreenShare((previous) => ({
      ...previous,
      sharing: false,
      label: undefined,
      requestedWhileIdle: false,
    }));
  }, [stopScreenFeed]);

  const startSharingScreen = useCallback(async () => {
    const shareGeneration = ++shareGenerationRef.current;
    stopScreenFeed();
    shareRef.current?.stop();
    shareRef.current = undefined;
    setScreenShare((previous) => ({
      ...previous,
      sharing: false,
      label: undefined,
      errorMessage: undefined,
    }));
    let handle: LiveScreenShareHandle;
    try {
      handle = await startScreenShare(() => {
        if (shareGeneration !== shareGenerationRef.current) return;
        shareGenerationRef.current += 1;
        stopScreenFeed();
        // The user pressed the browser's own "Stop sharing".
        shareRef.current = undefined;
        setScreenShare((previous) => ({
          ...previous,
          sharing: false,
          label: undefined,
        }));
      });
    } catch (error) {
      if (shareGeneration !== shareGenerationRef.current) return;
      // A refused picker is a choice, not a failure worth reporting back.
      const cancelled =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'AbortError');
      setScreenShare((previous) => ({
        ...previous,
        sharing: false,
        label: undefined,
        errorMessage: cancelled ? undefined : describeShareError(error),
      }));
      return;
    }
    if (shareGeneration !== shareGenerationRef.current) {
      handle.stop();
      return;
    }
    shareRef.current = handle;
    setScreenShare((previous) => ({
      ...previous,
      sharing: true,
      label: handle.label,
      errorMessage: undefined,
      requestedWhileIdle: false,
    }));
    startScreenFeed();
  }, [stopScreenFeed, startScreenFeed]);

  const release = useCallback(() => {
    shareGenerationRef.current += 1;
    stopScreenFeed();
    feedSupportedRef.current = false;
    feedAttemptRef.current = undefined;
    setScreenFeed({ supported: false, phase: 'idle' });
    const resources = resourcesRef.current;
    resourcesRef.current = {};
    if (resources.processor) resources.processor.onaudioprocess = null;
    resources.processor?.disconnect();
    if (resources.worklet) {
      resources.worklet.port.onmessage = null;
      resources.worklet.port.close();
      resources.worklet.disconnect();
    }
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
    inputLevelRef.current = SILENT_INPUT;
    droppingUntilRef.current = 0;
    // The share exists to feed this Host; losing the Host ends it, so no page
    // keeps a screen open that nothing can look at.
    shareRef.current?.stop();
    shareRef.current = undefined;
    setScreenShare((previous) => ({
      ...previous,
      sharing: false,
      label: undefined,
      lastLookAt: undefined,
      requestedWhileIdle: false,
    }));
  }, [stopScreenFeed]);

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
      setCaptureMode(undefined);
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
        // Either capture node only runs while it feeds a destination. A muted
        // gain node keeps the microphone out of the speakers.
        const sink = capture.createGain();
        sink.gain.value = 0;
        Object.assign(resourcesRef.current, { source, sink });

        // Frames arrive from whichever capture node gets built below; the
        // socket they go to is opened after it.
        let onFrame: (pcm: ArrayBuffer, level: number) => void = () => {};
        // addModule() is a network round trip, the only await between here and
        // the socket. Nothing is built or stored until it is back and this
        // connect is known to still be the current one: a node parked in
        // resourcesRef by an abandoned connect would belong to the next one.
        let workletLoaded = false;
        try {
          if (!capture.audioWorklet) throw new Error('AudioWorklet missing');
          await capture.audioWorklet.addModule(captureWorkletUrl);
          workletLoaded = true;
        } catch {
          // Falls back below.
        }
        if (!isCurrent()) return;

        let captureNode: AudioNode | undefined;
        if (workletLoaded) {
          try {
            const worklet = new AudioWorkletNode(
              capture,
              CAPTURE_WORKLET_PROCESSOR,
              {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 1,
                channelCountMode: 'explicit',
                processorOptions: { frameSize: LIVE_INPUT_FRAME_SIZE },
              },
            );
            worklet.port.onmessage = (
              event: MessageEvent<{ pcm: ArrayBuffer; level: number }>,
            ) => onFrame(event.data.pcm, event.data.level);
            resourcesRef.current.worklet = worklet;
            captureNode = worklet;
          } catch {
            // Falls back below.
          }
        }
        if (!captureNode) {
          // ScriptProcessorNode is deprecated and runs on the main thread, but
          // it needs no module load: the Web Shell CSP has no `blob:` or
          // `data:` in `script-src`, and a library build hands the worklet
          // over as exactly such a URL. Dictation makes the same choice.
          const processor = capture.createScriptProcessor(
            LIVE_INPUT_FRAME_SIZE,
            1,
            1,
          );
          processor.onaudioprocess = (event: AudioProcessingEvent) => {
            const { pcm, level } = floatToPcm16(
              event.inputBuffer.getChannelData(0),
            );
            onFrame(pcm, level);
          };
          resourcesRef.current.processor = processor;
          captureNode = processor;
        }
        setCaptureMode(
          resourcesRef.current.worklet ? 'worklet' : 'script-processor',
        );

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
                // Whether a screen is shared right now is not settled here:
                // this says the daemon may ask, and an unshared screen is
                // answered with a failure the model can relay.
                screenShare: canShareScreen(),
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
                if (message['epoch'] !== epochRef.current) {
                  if (
                    statusRef.current &&
                    (STREAMING_STATES.has(statusRef.current.state) ||
                      statusRef.current.state === 'starting')
                  ) {
                    stopSharingScreen();
                  } else {
                    stopScreenFeed();
                  }
                }
                epochRef.current = message['epoch'];
              }
              if (status) {
                if (!STREAMING_STATES.has(status.state)) stopScreenFeed();
                if (
                  statusRef.current &&
                  (STREAMING_STATES.has(statusRef.current.state) ||
                    statusRef.current.state === 'starting') &&
                  !STREAMING_STATES.has(status.state) &&
                  status.state !== 'starting'
                )
                  stopSharingScreen();
                statusRef.current = status;
                player.setMuted(status.outputMuted === true);
                onStatusRef.current?.(status);
              }
              if (message['type'] === 'host.welcome') {
                feedSupportedRef.current = message['screenFeedV1'] === true;
                setScreenFeed((previous) => ({
                  ...previous,
                  supported: feedSupportedRef.current,
                }));
                applyPhase('connected');
              }
              startScreenFeed();
              return;
            }
            case 'host.screen_feed_state': {
              const feed = feedRef.current;
              const next = message['phase'];
              if (
                !feed ||
                feed.id !== message['feedId'] ||
                feed.epoch !== message['epoch'] ||
                !['starting', 'streaming', 'stopped', 'error'].includes(
                  String(next),
                )
              )
                return;
              setScreenFeed({
                supported: true,
                feedId: feed.id,
                phase: next as LiveScreenFeedState['phase'],
                message:
                  typeof message['message'] === 'string'
                    ? message['message'].slice(0, 2000)
                    : undefined,
              });
              if (next === 'stopped' || next === 'error') {
                feed.cancel?.();
                feedRef.current = undefined;
              } else if (!feed.cancel && shareRef.current) {
                const share = shareRef.current;
                feed.cancel = sampleScreen({
                  grab: () => share.grab(),
                  canSend: () =>
                    isCurrent() &&
                    feedRef.current === feed &&
                    shareRef.current === share &&
                    epochRef.current === feed.epoch &&
                    !!statusRef.current &&
                    STREAMING_STATES.has(statusRef.current.state) &&
                    ws.readyState === WebSocket.OPEN &&
                    ws.bufferedAmount === 0,
                  send: (image) =>
                    ws.send(
                      JSON.stringify({
                        type: 'host.screen_feed_frame',
                        epoch: feed.epoch,
                        feedId: feed.id,
                        image,
                      }),
                    ),
                  onError: (error) => {
                    if (feedRef.current !== feed) return;
                    stopScreenFeed();
                    setScreenFeed({
                      supported: true,
                      feedId: feed.id,
                      phase: 'error',
                      message: describeShareError(error),
                    });
                  },
                });
              }
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
            case 'host.capture_visual': {
              const requestId = message['requestId'];
              if (typeof requestId !== 'string' || !requestId) return;
              const fail = (error: string) => {
                if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
                ws.send(
                  JSON.stringify({
                    type: 'host.visual_capture_result',
                    requestId,
                    success: false,
                    error,
                  }),
                );
              };
              if (message['source'] !== 'screen') {
                fail('This Host can only share a screen.');
                return;
              }
              // The daemon drops a result whose call has since changed, but by
              // then the frame has already left the machine. Refuse before
              // reading the screen at all.
              if (
                typeof message['epoch'] === 'number' &&
                message['epoch'] !== epochRef.current
              ) {
                fail('The Live call changed before the screen was read.');
                return;
              }
              const share = shareRef.current;
              if (!share) {
                setScreenShare((previous) => ({
                  ...previous,
                  requestedWhileIdle: true,
                }));
                fail('The user is not sharing a screen.');
                return;
              }
              const requestedEpoch = epochRef.current;
              const requestedShareGeneration = shareGenerationRef.current;
              void share
                .grab()
                .then((frame) => {
                  if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
                  if (
                    shareRef.current !== share ||
                    epochRef.current !== requestedEpoch ||
                    shareGenerationRef.current !== requestedShareGeneration
                  ) {
                    fail(
                      'The screen share or Live call changed before capture finished.',
                    );
                    return;
                  }
                  ws.send(
                    JSON.stringify({
                      type: 'host.visual_capture_result',
                      requestId,
                      success: true,
                      source: 'screen',
                      image: frame.image,
                      width: frame.width,
                      height: frame.height,
                      appName: 'Shared screen',
                      windowTitle: share.label,
                      // A page cannot read the accessibility tree of whatever
                      // it is shown; the image is the whole of the context.
                      accessibilityText: '',
                    }),
                  );
                  setScreenShare((previous) => ({
                    ...previous,
                    lastLookAt: performance.now(),
                  }));
                })
                .catch((error: unknown) => fail(describeShareError(error)));
              return;
            }
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

        onFrame = (pcm, level) => {
          if (!isCurrent()) return;
          const at = performance.now();
          const status = statusRef.current;
          if (
            ws.readyState !== WebSocket.OPEN ||
            !status ||
            status.inputMuted === true
          ) {
            // No socket, or muted: the meter reads zero rather than freezing
            // at the last level it saw.
            inputLevelRef.current = { level: 0, at, dropping: false };
            return;
          }
          const streaming = STREAMING_STATES.has(status.state);
          // Whether THIS frame is dropped decides what is sent; whether
          // dropping is REPORTED outlives it, or the flag would flicker.
          const dropped =
            streaming && ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES;
          if (dropped) droppingUntilRef.current = at + DROPPING_HOLD_MS;
          if (!streaming) droppingUntilRef.current = 0;
          const dropping = streaming && at < droppingUntilRef.current;
          // Measured whenever the microphone is open, including before the
          // call starts: "will it hear me?" is the question to answer while
          // there is still a button to press. During a call a dropped frame
          // is flagged, so a moving bar never means "the daemon hears this"
          // when it does not.
          inputLevelRef.current = { level, at, dropping };
          if (!streaming || dropped) return;
          const frame = new Uint8Array(INPUT_EPOCH_BYTES + pcm.byteLength);
          new DataView(frame.buffer).setBigUint64(0, BigInt(epochRef.current));
          frame.set(new Uint8Array(pcm), INPUT_EPOCH_BYTES);
          ws.send(frame.buffer);
        };
        source.connect(captureNode);
        captureNode.connect(sink);
        sink.connect(capture.destination);
      })();
    },
    [
      applyPhase,
      baseUrl,
      end,
      token,
      stopScreenFeed,
      stopSharingScreen,
      startScreenFeed,
    ],
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

  return {
    phase,
    closeReason,
    errorMessage,
    captureMode,
    inputLevel: inputLevelRef,
    connect,
    disconnect,
    screenShare,
    startSharingScreen,
    stopSharingScreen,
    screenFeed,
  };
}
