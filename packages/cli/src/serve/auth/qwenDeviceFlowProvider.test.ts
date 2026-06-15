/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `QwenOAuthDeviceFlowProvider`'s stderr audit path.
 *
 * PR #4291 follow-up review (qwen-latest, #1): the catch block in
 * `poll()` adds 4 distinct branches (AbortError skip, structured
 * `QwenOAuthPollError`, generic `Error` with name+length redaction,
 * non-Error throw) that drive what — if anything — lands in the
 * operator audit. The security-critical pieces are:
 *
 * - `device_code` + PKCE verifier are POSTed to the IdP per RFC 8628
 *   §3.4. A WAF / reverse proxy that echoes the request body in its
 *   error response would put both into stderr if we naively logged
 *   `err.message` — violating the BrandedSecret-style "secrets never
 *   appear in logs" contract the registry depends on.
 * - The cancel/dispose lifecycle MUST stay quiet — emitting a "poll
 *   failed" line on every normal cancellation pollutes the audit.
 *
 * These tests pin all four branches against a stub `IQwenOAuth2Client`
 * so a future refactor that drops the redaction shows up in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  QwenOAuthPollError,
  type IQwenOAuth2Client,
} from '@qwen-code/qwen-code-core';
import { QwenOAuthDeviceFlowProvider } from './qwenDeviceFlowProvider.js';
import { brandSecret } from './deviceFlow.js';

function fakeClient(
  overrides: Partial<IQwenOAuth2Client> = {},
): IQwenOAuth2Client {
  return {
    setCredentials: () => {},
    getCredentials: () =>
      ({}) as ReturnType<IQwenOAuth2Client['getCredentials']>,
    getAccessToken: async () => ({}),
    requestDeviceAuthorization: async () =>
      ({}) as Awaited<
        ReturnType<IQwenOAuth2Client['requestDeviceAuthorization']>
      >,
    pollDeviceToken: async () =>
      ({}) as Awaited<ReturnType<IQwenOAuth2Client['pollDeviceToken']>>,
    refreshAccessToken: async () =>
      ({}) as Awaited<ReturnType<IQwenOAuth2Client['refreshAccessToken']>>,
    ...overrides,
  };
}

describe('QwenOAuthDeviceFlowProvider.poll() — stderr audit branches', () => {
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof vi.fn>;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrLines = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    stderrSpy = vi.fn((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    // process.stderr.write has overloaded signatures; cast to align with
    // the chunk-only call shape used by writeStderrLine.
    (process.stderr as { write: unknown }).write = stderrSpy;
  });

  afterEach(() => {
    (process.stderr as { write: typeof originalWrite }).write = originalWrite;
  });

  function makeState() {
    return {
      deviceCode: brandSecret('device-code-secret-AAAA1111'),
      pkceVerifier: brandSecret('pkce-verifier-secret-BBBB2222'),
    };
  }

  it('skips stderr audit when caller aborted before poll started (signal.aborted check)', async () => {
    // The early `opts.signal.aborted` short-circuit returns `pending`
    // without invoking `pollDeviceToken` at all — no fetch, no catch,
    // no audit. Pin the negative case so a future refactor that
    // accidentally writes a stderr line on this path fails CI.
    const provider = new QwenOAuthDeviceFlowProvider(fakeClient());
    const controller = new AbortController();
    controller.abort();
    const result = await provider.poll(makeState(), {
      signal: controller.signal,
    });
    expect(result.kind).toBe('pending');
    expect(stderrLines).toHaveLength(0);
  });

  it('skips stderr audit when AbortError is thrown AND the registry-owned signal is aborted (cancel/dispose lifecycle)', async () => {
    // `cancel()` / `dispose()` aborts the AbortController and the
    // underlying fetch throws an `AbortError`-like exception. This
    // is normal lifecycle. The post-await `opts.signal.aborted`
    // check is what proves WE caused the abort — that's the gate,
    // not the error name itself.
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    const controller = new AbortController();
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          controller.abort();
          throw abortErr;
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: controller.signal,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.errorKind).toBe('upstream_error');
    }
    expect(stderrLines).toHaveLength(0);
  });

  it('LOGS unexpected AbortError when the registry-owned signal is NOT aborted (transport / proxy / undici)', async () => {
    // PR #4291 follow-up review (gpt-5.5, #1): an `AbortError` can
    // come from sources we did NOT initiate — upstream IdP TCP RST,
    // proxy timeout, undici/node-fetch wrapping unrelated transport
    // failures as AbortError. Earlier shape silently dropped these
    // because of the `err.name === 'AbortError'` skip; now we only
    // skip when WE caused the abort. Unexpected AbortError must
    // still produce a stderr breadcrumb.
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw abortErr;
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      // Signal NOT aborted — the abort came from an upstream source.
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.errorKind).toBe('upstream_error');
    }
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    // Routes through the non-OAuth Error path (name + length).
    expect(line).toContain('AbortError');
    expect(line).toContain('raw suppressed');
    // Negative: the raw message is NOT echoed.
    expect(line).not.toContain('The operation was aborted.');
  });

  it('skips stderr audit when signal.aborted is set after the throw, even for non-AbortError errors', async () => {
    // The other half of the abort guard: a cooperative provider
    // notices the signal is aborted post-fetch and throws something
    // generic. We still treat the post-await `signal.aborted` as
    // proof this was a cancel, not a real failure.
    const controller = new AbortController();
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          controller.abort();
          throw new Error('socket hangup');
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: controller.signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(0);
  });

  it('logs only the structured oauthError field on QwenOAuthPollError (no raw body, no device_code/PKCE leak)', async () => {
    // Critical security path: even when the upstream RESPONSE includes
    // the request body verbatim (WAF echo, hostile reverse proxy), the
    // QwenOAuthPollError carries only the structured `oauthError` /
    // `description` fields. Logging those is safe; logging
    // `err.message` would re-introduce the leak vector.
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new QwenOAuthPollError({
            oauthError: 'slow_down',
            description: 'Polling too fast',
            status: 400,
          });
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    expect(line).toContain('qwen device-flow poll failed');
    expect(line).toContain('oauthError=slow_down');
    // The raw default message ("Device token poll failed: slow_down -
    // Polling too fast") MUST NOT appear — only the structured field.
    expect(line).not.toContain('Device token poll failed:');
    expect(line).not.toContain('device-code-secret');
    expect(line).not.toContain('pkce-verifier-secret');
  });

  it('logs only err.name + message length on generic Error (raw message is suppressed)', async () => {
    // The catch block treats any non-OAuth Error as potentially
    // tainted (a fetch wrapper that templated the request body into
    // its message). Log just the constructor name + length so
    // on-call gets a triage-able breadcrumb without the request body.
    const longMessage =
      'HTTP 502 from qwen IdP: <html><body>Forbidden — request body: device_code=device-code-secret-AAAA1111&code_verifier=pkce-verifier-secret-BBBB2222</body></html>';
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new Error(longMessage);
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.errorKind).toBe('upstream_error');
    }
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    expect(line).toContain('Error');
    expect(line).toContain(`message ${longMessage.length} bytes`);
    expect(line).toContain('raw suppressed');
    // Hard assertions: NEITHER the raw message NOR the templated
    // device-flow secrets may appear in stderr.
    expect(line).not.toContain('HTTP 502 from qwen');
    expect(line).not.toContain('device-code-secret');
    expect(line).not.toContain('pkce-verifier-secret');
  });

  it('logs <non-Error throw: typeof> placeholder when a non-Error value is thrown', async () => {
    // `throw 'string'` is bad practice but fetch wrappers sometimes
    // do it (or `throw { code: 'X' }`). The catch block writes a
    // typeof-bound placeholder and gives up on extracting more —
    // the typed return shape (`upstream_error`) carries enough for
    // the SSE consumer.
    // The catch in poll() must handle non-Error throws. We wrap the
    // raw throw inside a sync function called from the async path so
    // the lint rule against literal throws can stay enabled — the
    // reject value is what we're testing, not the throw idiom.
    const nonErrorThrower = (): never => {
      const value: unknown = 'this is not an Error instance';
      throw value as Error;
    };
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => nonErrorThrower(),
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    expect(line).toContain('<non-Error throw: string>');
    // The raw thrown string is NOT echoed.
    expect(line).not.toContain('this is not an Error instance');
  });

  it('reports the resolved errorKind on every emitted stderr line so triage can branch on it', async () => {
    // Mapping check: the `errorKind` field in the typed return AND
    // the stderr breadcrumb must agree. A mis-mapping here would
    // route the SSE consumer one way and the operator another.
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new QwenOAuthPollError({
            oauthError: 'access_denied',
            description: 'user declined',
            status: 400,
          });
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.errorKind).toBe('access_denied');
    }
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('errorKind=access_denied');
    expect(stderrLines[0]).toContain('oauthError=access_denied');
  });

  it('sanitizes control characters and ANSI escapes in attacker-controlled oauthError before stderr interpolation', async () => {
    // PR #4291 follow-up review (gpt-5.5, #2): the OAuth `error` field
    // comes directly from the upstream JSON. A compromised IdP / WAF
    // / proxy can return a value containing newlines, terminal control
    // characters, or ANSI escape sequences — interpolating that
    // verbatim into a stderr line would forge additional log entries
    // or inject color/cursor-movement sequences into operator
    // terminals. `sanitizeForStderr` strips C0/C1 controls + DEL.
    const malicious =
      'slow_down\n[serve] FORGED LOG ENTRY 2026-01-01\x1b[31mRED\x1b[0m';
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new QwenOAuthPollError({
            oauthError: malicious,
            description: 'attacker-supplied',
            status: 400,
          });
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    // The forged log line text MUST NOT appear as a real second line.
    // Implementation replaces \n with `?`, so the body is on a single
    // line and the second `[serve]` no longer leads a line.
    expect(line.split('\n').length).toBe(2); // single content line + trailing newline
    // ANSI escape \x1b is gone.
    expect(line).not.toContain('\x1b[31m');
    expect(line).not.toContain('\x1b[0m');
    // Newline inside the value is gone.
    expect(line).not.toMatch(/\n\[serve\] FORGED/);
    // The literal text after the controls is preserved (operator can
    // still see what the IdP claimed) — only the harmful bytes are
    // replaced.
    expect(line).toContain('FORGED LOG ENTRY');
    expect(line).toContain('RED');
  });

  it('sanitizes control characters in attacker-controlled err.name on the non-OAuth path (round-4 #4)', async () => {
    // PR #4291 follow-up review (qwen-latest, round-4 #4):
    // `Error.name` is a freely assignable string property. A hostile
    // provider or fetch wrapper could set `e.name` to inject newlines
    // or ANSI sequences into stderr through the same vector we
    // already closed for `oauthError`. Pin the equivalent
    // sanitization on the non-OAuth path.
    const err = new Error('upstream HTTP 500');
    err.name = 'Hostile\n[serve] FORGED LINE 2026-01-01\x1b[31mRED\x1b[0m';
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw err;
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    // Single content line — no forged second log entry.
    expect(line.split('\n').length).toBe(2);
    // Hostile bytes from name are gone.
    expect(line).not.toContain('\x1b[31m');
    expect(line).not.toContain('\x1b[0m');
    expect(line).not.toMatch(/\n\[serve\] FORGED/);
    // Substantive parts of the name are still preserved (length-
    // preserving sanitizer replaces controls with `?`).
    expect(line).toContain('Hostile');
    expect(line).toContain('FORGED LINE');
    expect(line).toContain('RED');
    // Length field is the message length, not name length.
    expect(line).toContain(`message ${err.message.length} bytes`);
  });

  it('sanitizes Unicode lookalike controls (U+2028 LINE SEPARATOR, bidi, ZWNBSP) in oauthError (round-5 #4)', async () => {
    // PR #4291 follow-up review (deepseek-v4-pro, round-5 #4): the
    // round-3 sanitizer only stripped ASCII C0/C1 + DEL; a hostile
    // IdP could bypass with U+2028 (LINE SEPARATOR — rendered as a
    // newline in many Unicode-aware terminals) or zero-width / bidi
    // controls. Pin the extended coverage with a payload that mixes
    // U+2028 (LINE SEPARATOR), U+200E (LRM), and U+FEFF (BOM).
    //
    // PR #4291 follow-up review (gpt-5.5, round-6 #1): the original
    // shape embedded the invisible Unicode controls as literal
    // characters in the source ('\u2028' between `slow_down` and
    // `[serve]`, `\u200e` before `RTL`, `\ufeff` at the end). That
    // makes the test source unreviewable in GitHub diffs / many
    // editors and the negative assertions look like checks for empty
    // / whitespace strings. Switched to explicit `\uXXXX` escapes in
    // both the payload and `not.toContain(...)` assertions.
    const U_2028_LINE_SEP = '\u2028';
    const U_200E_LRM = '\u200e';
    const U_FEFF_BOM = '\ufeff';
    const malicious = `slow_down${U_2028_LINE_SEP}[serve] FAKE LOG ${U_200E_LRM}RTL${U_FEFF_BOM}`;
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new QwenOAuthPollError({
            oauthError: malicious,
            description: 'attacker-supplied unicode',
            status: 400,
          });
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    // None of the Unicode lookalikes survive into stderr.
    expect(line).not.toContain(U_2028_LINE_SEP);
    expect(line).not.toContain(U_200E_LRM);
    expect(line).not.toContain(U_FEFF_BOM);
    // The forged log line text MUST NOT lead an actual newline.
    expect(line.split('\n').length).toBe(2); // single content + trailing
    // Substantive parts preserved (`?`-replaced, length-preserving).
    expect(line).toContain('FAKE LOG');
    expect(line).toContain('RTL');
  });

  it('sanitizes Unicode bidi ISOLATE controls U+2066–U+2069 (CVE-2021-42574 Trojan Source) (round-6 #5)', async () => {
    // Round-6 review (qwen-latest, #5): the round-5 regex covered
    // U+202A–U+202E (embedding/override) but missed U+2066–U+2069
    // (LRI/RLI/FSI/PDI). These bidi ISOLATE controls are the primary
    // CVE-2021-42574 attack vectors — a hostile IdP swapping
    // \u2066 (LRI) for \u202d (LRO) achieves the same visual reordering
    // and would have bypassed the round-5 filter entirely.
    const U_2066_LRI = '\u2066';
    const U_2068_FSI = '\u2068';
    const U_2069_PDI = '\u2069';
    const provider = new QwenOAuthDeviceFlowProvider(
      fakeClient({
        pollDeviceToken: async () => {
          throw new QwenOAuthPollError({
            oauthError: `access_denied${U_2066_LRI}HIDDEN${U_2069_PDI}${U_2068_FSI}`,
            description: 'trojan source',
            status: 400,
          });
        },
      }),
    );
    const result = await provider.poll(makeState(), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('error');
    expect(stderrLines).toHaveLength(1);
    const line = stderrLines[0];
    expect(line).not.toContain(U_2066_LRI);
    expect(line).not.toContain(U_2068_FSI);
    expect(line).not.toContain(U_2069_PDI);
    // Substantive parts still visible.
    expect(line).toContain('access_denied');
    expect(line).toContain('HIDDEN');
  });
});
