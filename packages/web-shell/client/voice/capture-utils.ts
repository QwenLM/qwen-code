/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transport-agnostic pieces of browser microphone capture, shared by voice
 * dictation (`/voice/stream`) and the Live Voice browser Host (`/live/web`).
 */

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
export const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

export function bearerSubprotocol(token: string): string {
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

export function describeMicError(err: unknown): string {
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
export function floatToPcm16(input: Float32Array): {
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

/** `Sec-WebSocket-Protocol` values that carry the daemon bearer token. */
export function voiceWebSocketProtocols(token?: string): string[] | undefined {
  return token ? [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)] : undefined;
}

/** Microphone constraints: mono, with the browser's echo and noise handling. */
export const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
  },
};
