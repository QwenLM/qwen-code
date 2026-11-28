/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isClientRequestFailurePhase,
  isPreRequestFailurePhase,
  isTlsCertRouteFailure,
  readNetworkFailurePhase,
  readNetworkFailurePhaseFromErrorCodes,
} from './networkUtils.js';
import { ProtocolLimitError } from '../../utils/protocol-limits.js';

function fetchFailedWithCause(cause: Error): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function fetchFailedWithCode(code: string, message: string): TypeError {
  return fetchFailedWithCause(Object.assign(new Error(message), { code }));
}

describe('network-error-classifier', () => {
  it.each([false, true])(
    'classifies a runtime TimeoutError as timeout (wrapped=%s)',
    (wrapped) => {
      const timeout = new DOMException('transport deadline', 'TimeoutError');
      expect(
        readNetworkFailurePhase(
          wrapped ? new Error('fetch failed', { cause: timeout }) : timeout,
        ),
      ).toBe('timeout');
    },
  );

  it.each([false, true])(
    'classifies Bun ConnectionRefused as connect (wrapped=%s)',
    (wrapped) => {
      const cause = Object.assign(
        new TypeError(
          'Unable to connect. Is the computer able to access the url?',
        ),
        { code: 'ConnectionRefused' },
      );
      const error = wrapped ? new Error('request failed', { cause }) : cause;

      expect(readNetworkFailurePhase(error)).toBe('connect');
      expect(readNetworkFailurePhaseFromErrorCodes(error)).toBe('connect');
    },
  );

  it('does not infer a connect failure from generic Bun wording alone', () => {
    const error = new TypeError(
      'Unable to connect. Is the computer able to access the url?',
    );

    expect(readNetworkFailurePhase(error)).toBe('unknown');
    expect(readNetworkFailurePhaseFromErrorCodes(error)).toBeUndefined();
  });

  it('keeps wrapped protocol limits out of address fallback', () => {
    const error = fetchFailedWithCause(
      new ProtocolLimitError(
        'HTTP response headers exceed 16384 bytes',
        'http_response_headers',
        16_384,
        16_385,
      ),
    );

    expect(readNetworkFailurePhase(error)).toBe('protocol');
  });

  it('treats proxy connect timeout as a transport fallback reason', () => {
    const error = fetchFailedWithCause(
      new Error('proxy connect timed out after 65000ms'),
    );

    expect(readNetworkFailurePhase(error)).toBe('proxy_connect');
    expect(isPreRequestFailurePhase('proxy_connect')).toBe(true);
  });

  it('keeps concrete network phase when deadline also expires', () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    const error = fetchFailedWithCode('ECONNREFUSED', 'connection refused');

    expect(
      readNetworkFailurePhase(error, { deadlineSignal: deadline.signal }),
    ).toBe('connect');
  });

  it('classifies a pure deadline abort as timeout', () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });

    expect(
      readNetworkFailurePhase(error, { deadlineSignal: deadline.signal }),
    ).toBe('timeout');
  });

  it('classifies local request timeout as response header timeout', () => {
    const error = fetchFailedWithCause(
      new Error('Request timed out after 120000ms'),
    );

    expect(readNetworkFailurePhase(error)).toBe('response_headers');
  });

  it('identifies TLS certificate validation failures for route-health isolation', () => {
    const error = fetchFailedWithCode(
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'unable to verify the first certificate',
    );

    const phase = readNetworkFailurePhase(error);
    expect(phase).toBe('tls');
    expect(isTlsCertRouteFailure(phase, error)).toBe(true);
  });

  it('does not classify incidental certificate text as a TLS failure', () => {
    const error = new Error(
      'upstream certificate check pending, retry after capacity recovers',
    );

    expect(readNetworkFailurePhase(error)).toBe('unknown');
    expect(isTlsCertRouteFailure('tls', error)).toBe(false);
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'CERT_UNTRUSTED',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ])('classifies certificate code %s as TLS without message hints', (code) => {
    const error = fetchFailedWithCode(code, 'validation failed');

    const phase = readNetworkFailurePhase(error);
    expect(phase).toBe('tls');
    expect(isTlsCertRouteFailure(phase, error)).toBe(true);
  });

  it('keeps TLS handshake failures eligible for transport fallback', () => {
    const error = fetchFailedWithCode(
      'ERR_TLS_HANDSHAKE_TIMEOUT',
      'tls handshake timeout',
    );

    const phase = readNetworkFailurePhase(error);
    expect(phase).toBe('tls');
    expect(isPreRequestFailurePhase(phase)).toBe(true);
    expect(isTlsCertRouteFailure(phase, error)).toBe(false);
  });

  it('does not classify connection errors to ssl-named hosts as TLS failures', () => {
    const error = fetchFailedWithCode(
      'ECONNREFUSED',
      'connect ECONNREFUSED ssl-gw.internal:443',
    );

    expect(readNetworkFailurePhase(error)).toBe('connect');
  });

  it('keeps connection error codes above incidental certificate text', () => {
    const error = fetchFailedWithCode(
      'ECONNREFUSED',
      'connect ECONNREFUSED certificate gateway:443',
    );

    expect(readNetworkFailurePhase(error)).toBe('connect');
  });

  it('treats a bare ETIMEDOUT as a connect failure eligible for fallback', () => {
    const error = fetchFailedWithCode('ETIMEDOUT', 'operation timed out');

    expect(readNetworkFailurePhase(error)).toBe('connect');
  });

  it.each(['ECONNRESET', 'ECONNABORTED', 'UND_ERR_SOCKET'])(
    'treats ambiguous socket code %s as post-commit for replay safety',
    (code) => {
      const error = fetchFailedWithCode(code, 'socket reset');

      expect(readNetworkFailurePhase(error)).toBe('response_headers');
    },
  );

  it('classifies an unwrapped undici mid-stream peer close', () => {
    const error = Object.assign(new Error('other side closed'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
    });

    expect(readNetworkFailurePhase(error)).toBe('response_headers');
    expect(readNetworkFailurePhaseFromErrorCodes(error)).toBe(
      'response_headers',
    );
  });

  it.each(['other side closed', 'socket connection was closed unexpectedly'])(
    'recognizes the socket close wording %s without an error code',
    (message) => {
      expect(readNetworkFailurePhase(new Error(message))).toBe(
        'response_headers',
      );
    },
  );

  it('keeps the code-only classifier free of message fallbacks', () => {
    expect(
      readNetworkFailurePhaseFromErrorCodes(new Error('other side closed')),
    ).toBeUndefined();
    expect(
      readNetworkFailurePhaseFromErrorCodes(new TypeError('fetch failed')),
    ).toBeUndefined();
  });

  it('does not assume a context-free fetch failure happened before send', () => {
    const error = new TypeError('fetch failed');

    expect(readNetworkFailurePhase(error)).toBe('unknown');
  });

  it('recognizes grpc-js connection failures embedded in status details', () => {
    const error = Object.assign(
      new Error(
        '14 UNAVAILABLE: No connection established. Last error: connect ECONNREFUSED 203.0.113.1:443',
      ),
      { code: 14 },
    );

    expect(readNetworkFailurePhase(error)).toBe('connect');
  });

  it('recognizes grpc-js DNS failures embedded in status details', () => {
    const error = Object.assign(
      new Error(
        '14 UNAVAILABLE: Name resolution failed for target: getaddrinfo ENOTFOUND api.example.com',
      ),
      { code: 14 },
    );

    expect(readNetworkFailurePhase(error)).toBe('dns');
  });

  it('keeps an application-level gRPC unavailable status out of IP failure phases', () => {
    const error = Object.assign(
      new Error('14 UNAVAILABLE: model capacity temporarily unavailable'),
      { code: 14 },
    );

    expect(readNetworkFailurePhase(error)).toBe('unknown');
  });

  it('keeps ETIMEDOUT with request-timeout context in response headers', () => {
    const error = fetchFailedWithCode(
      'ETIMEDOUT',
      'Request timed out after 120000ms',
    );

    expect(readNetworkFailurePhase(error)).toBe('response_headers');
  });

  it('keeps ETIMEDOUT with TLS-handshake context in TLS', () => {
    const error = fetchFailedWithCode('ETIMEDOUT', 'TLS handshake timed out');

    expect(readNetworkFailurePhase(error)).toBe('tls');
  });

  it('classifies a non-ASCII header value as a local request-build failure', () => {
    // What a machine named "CLP毛衣" produces: undici refuses to build the
    // request, so this is not a network failure and must not read as one.
    let error: unknown;
    try {
      new Request('https://infer.example.com/chat', {
        headers: { 'Cosy-MachineHostname': 'CLP毛衣' },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(readNetworkFailurePhase(error)).toBe('request_build');
    expect(isClientRequestFailurePhase('request_build')).toBe(true);
  });

  it('classifies illegal header content reported by Node as request_build', () => {
    const error = fetchFailedWithCode(
      'ERR_INVALID_CHAR',
      'Invalid character in header content ["Cosy-MachineHostname"]',
    );

    expect(readNetworkFailurePhase(error)).toBe('request_build');
    expect(readNetworkFailurePhaseFromErrorCodes(error)).toBe('request_build');
  });

  it('classifies an invalid header value reported by Bun as request_build', () => {
    // Bun emits a code-less TypeError with this word order, which differs from
    // undici's ByteString message and Node's ERR_INVALID_CHAR errors.
    const error = new TypeError(
      "Header 'Cosy-MachineHostname' has invalid value: 'CLP毛衣'",
    );

    expect(readNetworkFailurePhase(error)).toBe('request_build');
  });

  it('classifies gRPC metadata rejection as request_build', () => {
    const error = new Error(
      'Metadata value "CLP毛衣" contains illegal characters',
    );

    expect(readNetworkFailurePhase(error)).toBe('request_build');
  });

  it('keeps request_build out of pre-request address failover', () => {
    // Nothing was sent, but the failure is deterministic: replaying it on every
    // candidate route would only repeat the same local error.
    expect(isPreRequestFailurePhase('request_build')).toBe(false);
  });

  it('leaves genuine network failures unclassified as request_build', () => {
    expect(
      readNetworkFailurePhase(
        fetchFailedWithCode('ECONNREFUSED', 'connection refused'),
      ),
    ).toBe('connect');
    expect(isClientRequestFailurePhase('connect')).toBe(false);
  });

  it('preserves an explicit stream-idle phase instead of treating it as connect', () => {
    const error = Object.assign(new Error('model stream idle timeout'), {
      code: 'ETIMEDOUT',
      phase: 'stream_idle',
    });

    expect(readNetworkFailurePhase(error)).toBe('stream_idle');
  });

  it('prefers a structured phase from a nested runtime cause', () => {
    const error = fetchFailedWithCause(
      Object.assign(new Error('operation timed out'), {
        code: 'ETIMEDOUT',
        phase: 'tls',
      }),
    );

    expect(readNetworkFailurePhase(error)).toBe('tls');
  });

  it('does not map caller abort to fallback when caller signal is available', () => {
    const caller = new AbortController();
    caller.abort(new DOMException('user abort', 'AbortError'));
    const error = fetchFailedWithCause(
      Object.assign(new Error('request aborted'), { name: 'AbortError' }),
    );

    expect(
      readNetworkFailurePhase(error, { callerSignal: caller.signal }),
    ).toBe('abort');
  });

  it('treats an aborted caller signal as authoritative for a plain Error reason', () => {
    const caller = new AbortController();
    const reason = new Error('cancelled by caller');
    caller.abort(reason);

    expect(
      readNetworkFailurePhase(reason, { callerSignal: caller.signal }),
    ).toBe('abort');
  });

  it('preserves a structured first-payload timeout carried by the caller signal', () => {
    const caller = new AbortController();
    const reason = Object.assign(new Error('first payload timed out'), {
      code: 'ETIMEDOUT',
      phase: 'first_payload',
    });
    caller.abort(reason);

    expect(
      readNetworkFailurePhase(reason, { callerSignal: caller.signal }),
    ).toBe('first_payload');
  });

  it.each(['dns', 'proxy_connect', 'connect', 'tls'] as const)(
    'treats %s as a pre-request failure phase',
    (phase) => {
      expect(isPreRequestFailurePhase(phase)).toBe(true);
    },
  );

  it.each([
    'request_write',
    'response_headers',
    'first_payload',
    'body',
    'timeout',
  ] as const)('does not treat %s as a pre-request failure phase', (phase) => {
    expect(isPreRequestFailurePhase(phase)).toBe(false);
  });
});
