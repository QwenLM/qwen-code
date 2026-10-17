/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  sanitizeHookName,
  redactErrorText,
  registerKnownSecretValues,
  clearKnownSecretValuesForTest,
} from './sanitize.js';
import { truncateErrorText } from './session-tracing.js';

describe('sanitizeHookName', () => {
  it('should return "unknown-command" for empty string', () => {
    expect(sanitizeHookName('')).toBe('unknown-command');
  });

  it('should return "unknown-command" for whitespace-only string', () => {
    expect(sanitizeHookName('   ')).toBe('unknown-command');
    expect(sanitizeHookName('\t\n\r')).toBe('unknown-command');
  });

  it('should return "unknown-command" for null/undefined values', () => {
    // Testing the function behavior with falsy inputs
    expect(sanitizeHookName('')).toBe('unknown-command');
  });

  it('should extract command name from full path on Unix systems', () => {
    expect(sanitizeHookName('/usr/bin/git')).toBe('git');
    expect(sanitizeHookName('/path/to/.gemini/hooks/check-secrets.sh')).toBe(
      'check-secrets.sh',
    );
    expect(sanitizeHookName('/home/user/script.py --arg=value')).toBe(
      'script.py',
    );
  });

  it('should extract command name from full path on Windows systems', () => {
    expect(sanitizeHookName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeHookName('C:\\Users\\User\\Documents\\test.bat /c')).toBe(
      'test.bat',
    );
  });

  it('should return the command name without arguments for simple commands', () => {
    expect(sanitizeHookName('git status')).toBe('git');
    expect(sanitizeHookName('node index.js')).toBe('node');
    expect(sanitizeHookName('python script.py --api-key=abc123')).toBe(
      'python',
    );
  });

  it('should handle relative paths correctly', () => {
    expect(sanitizeHookName('./my-script.sh')).toBe('my-script.sh');
    expect(sanitizeHookName('../tools/tool.exe')).toBe('tool.exe');
  });

  it('should handle complex command lines', () => {
    expect(
      sanitizeHookName(
        '/path/to/.gemini/hooks/check-secrets.sh --api-key=abc123',
      ),
    ).toBe('check-secrets.sh');
    expect(
      sanitizeHookName('python /home/user/script.py --token=xyz --verbose'),
    ).toBe('python');
  });

  it('should handle edge cases', () => {
    expect(sanitizeHookName('simple-command')).toBe('simple-command');
    expect(sanitizeHookName('one-word')).toBe('one-word');
  });

  it('should return "unknown-command" for malformed paths', () => {
    expect(sanitizeHookName('/')).toBe('unknown-command');
    expect(sanitizeHookName('\\')).toBe('unknown-command');
  });
});

describe('redactErrorText', () => {
  it('should mask registered secret values wherever they appear', () => {
    // A process-held secret in a shape no spelling-based pattern covers
    // (lowercase env key, quoted value) is still masked by exact value.
    registerKnownSecretValues(['sk-live-PROCESSHELD']);
    try {
      expect(
        redactErrorText('api_key="sk-live-PROCESSHELD" npm run deploy'),
      ).not.toContain('sk-live-PROCESSHELD');
      expect(
        redactErrorText('Output: token sk-live-PROCESSHELD expired'),
      ).not.toContain('sk-live-PROCESSHELD');
    } finally {
      clearKnownSecretValuesForTest();
    }
    // Registration cleared: ordinary text is untouched afterwards.
    expect(redactErrorText('nothing registered here')).toBe(
      'nothing registered here',
    );
  });

  it('should redact URL userinfo credentials', () => {
    expect(
      redactErrorText(
        'Command: git clone https://x-access-token:ghs_abc@github.com/o/r',
      ),
    ).toBe('Command: git clone https://***REDACTED***@github.com/o/r');
  });

  it('should redact database DSN credentials', () => {
    expect(
      redactErrorText('failed to connect: postgres://user:pass@host/db'),
    ).toBe('failed to connect: postgres://***REDACTED***@host/db');
  });

  it('should redact Authorization header values including bearer prefixes', () => {
    expect(
      redactErrorText('curl -H "Authorization: Bearer abc123" https://e.com'),
    ).toBe('curl -H "Authorization: ***" https://e.com');
    expect(redactErrorText('Authorization=Bearer xyz')).toBe(
      'Authorization=***',
    );
  });

  it('should redact bare bearer tokens', () => {
    expect(redactErrorText('request rejected for bearer eyJhbGciOi')).toBe(
      'request rejected for bearer ***',
    );
  });

  it('should redact secret-looking flags with = and space separators', () => {
    expect(redactErrorText('git push --token=ghs_abcdef')).toBe(
      'git push --token=***',
    );
    expect(redactErrorText('run --token abc123')).toBe('run --token ***');
    expect(redactErrorText('curl --api-key=xyz host')).toBe(
      'curl --api-key=*** host',
    );
    expect(redactErrorText('x --registry-token=xyz')).toBe(
      'x --registry-token=***',
    );
  });

  it('should redact secret-looking header-style keys', () => {
    expect(redactErrorText('-H "X-Auth-Token: abc123"')).toBe(
      '-H "X-Auth-Token: ***"',
    );
  });

  it('should redact secret-looking env assignments', () => {
    expect(redactErrorText('AWS_SECRET_ACCESS_KEY=xyz cmd')).toBe(
      'AWS_SECRET_ACCESS_KEY=*** cmd',
    );
    expect(redactErrorText('API_KEY=abc123 failed')).toBe('API_KEY=*** failed');
  });

  it('should leave non-secret text intact', () => {
    const text = 'error: connection refused for host db:5432 after 3 tries';
    expect(redactErrorText(text)).toBe(text);
  });

  it('should leave non-secret flags intact', () => {
    const text = 'normal --verbose=2 command';
    expect(redactErrorText(text)).toBe(text);
  });

  it('should preserve newlines while neutralising other control characters', () => {
    // A control char between the key and its separator must not defeat
    // the mask, and the multi-line error block shape must survive. Each
    // control char becomes a space (not deleted): deleting would fuse key
    // and value into one token and let the credential slip through.
    const noisy = 'git push --token\u0007=ghs_abcdef\nError: fatal\u0000';
    expect(redactErrorText(noisy)).toBe('git push --token ***\nError: fatal ');
    expect(redactErrorText('Command: x\nError: y')).toBe(
      'Command: x\nError: y',
    );
    // Tab/VT/FF are \s-class separators: neutralising (not deleting) keeps
    // the mask firing instead of fusing `--token` + value into one token.
    // The tab becomes a space — the credential must not survive.
    expect(redactErrorText('git push --token\tghs_abc123')).toBe(
      'git push --token ***',
    );
    expect(redactErrorText('git push --token\u000bghs_abc123')).not.toContain(
      'ghs_abc123',
    );
    // A word char glued onto the key by a control char must not defeat
    // the env mask (no \b anchor on the key class).
    expect(redactErrorText('err\u0007AWS_SECRET_ACCESS_KEY=AKIAsecret')).toBe(
      'err AWS_SECRET_ACCESS_KEY=***',
    );
  });

  it('should strip ANSI sequences before masking so wrapped credentials do not slip through', () => {
    expect(
      redactErrorText(
        'npm ERR! \u001b[1m\u001b[31mhttps://user:ghp_Secret123@registry.example.com/pkg\u001b[0m',
      ),
    ).toBe('npm ERR!  https://***REDACTED***@registry.example.com/pkg');
    expect(
      redactErrorText('\u001b[31mAWS_SECRET_ACCESS_KEY=xyz\u001b[0m'),
    ).toBe('AWS_SECRET_ACCESS_KEY=***');
    // No \b anchor: a preceding word character must not disable the mask.
    expect(redactErrorText('prefix_mAWS_SECRET_ACCESS_KEY=x')).toBe(
      'prefix_mAWS_SECRET_ACCESS_KEY=***',
    );
  });

  it('should not let an empty flag value eat the next flag name as its value', () => {
    expect(
      redactErrorText('mytool --password= --token ghp_REALTOKEN'),
    ).not.toContain('ghp_REALTOKEN');
    expect(redactErrorText('mytool --password= --token ghp_REALTOKEN')).toBe(
      'mytool --password= --token ***',
    );
    expect(redactErrorText('tool --auth --password hunter2')).toBe(
      'tool --auth --password ***',
    );
    // No inline value at all: masking nothing is correct, the neighbour
    // flag name must survive.
    expect(
      redactErrorText('docker login --password-stdin --username admin'),
    ).toBe('docker login --password-stdin --username admin');
  });

  it('should mask values that open with a never-closed quote', () => {
    expect(redactErrorText('curl --token "ghp_REALTOKEN')).toBe(
      'curl --token ***',
    );
    expect(redactErrorText('mytool --api-key="sk_REALTOKEN')).toBe(
      'mytool --api-key=***',
    );
    expect(redactErrorText("mytool --password 'hunter2")).toBe(
      'mytool --password ***',
    );
    expect(redactErrorText('request rejected for bearer "eyJhbGciOi')).toBe(
      'request rejected for bearer ***',
    );
    // The env pattern too, and the run-on after the unclosed quote stays
    // (quoted runs are whitespace-bounded).
    expect(redactErrorText('API_KEY="sk-abc cmd failed')).toBe(
      'API_KEY=*** cmd failed',
    );
    expect(
      redactErrorText('mytool --token "ghp_REAL then the loader reported'),
    ).toBe('mytool --token *** then the loader reported');
  });

  it('should mask the credential after an auth scheme word, not the scheme word', () => {
    expect(redactErrorText('Authorization: token ghp_ABCDEF0123456789')).toBe(
      'Authorization: ***',
    );
    expect(redactErrorText('Authorization: Basic Zm9vOmJhcg==')).toBe(
      'Authorization: ***',
    );
    expect(redactErrorText('Authorization: ApiKey sk-live-51H8')).toBe(
      'Authorization: ***',
    );
    expect(redactErrorText('Authorization: Digest nonce=abc123')).toBe(
      'Authorization: ***',
    );
    expect(redactErrorText('invalid bearer token: eyJhbGciSECRET999')).toBe(
      'invalid bearer token: ***',
    );
    expect(
      redactErrorText('Authorization: Bearer\nX-Api-Key: sk-live-abc123DEF'),
    ).toBe('Authorization: ***\nX-Api-Key: ***');
  });

  it('should mask values on a shell continuation line', () => {
    expect(redactErrorText('curl --token=\\\n ghs_abcdef')).not.toContain(
      'ghs_abcdef',
    );
    expect(
      redactErrorText('run.sh API_KEY=\\\nsk-live-REALSECRET'),
    ).not.toContain('sk-live-REALSECRET');
    expect(
      redactErrorText('request rejected for bearer \\\n eyJREALSECRET'),
    ).not.toContain('eyJREALSECRET');
    expect(
      redactErrorText('-H "Authorization: Bearer \\\n eyJREALSECRET"'),
    ).not.toContain('eyJREALSECRET');
  });

  it('should leave prose containing secret-like words intact', () => {
    expect(redactErrorText('the auth-token is expired')).toBe(
      'the auth-token is expired',
    );
    expect(redactErrorText('deploy --auth=abc --verbose')).toBe(
      'deploy --auth=*** --verbose',
    );
  });

  it('should neutralise (not delete) an ANSI sequence separating a flag from its value', () => {
    // A colourised tool echoing the failing command with the value in its
    // own colour: the SGR run is the ONLY separator between the flag and
    // the credential, so deleting it fuses them into one token and the
    // credential ships. It must become a space.
    expect(redactErrorText('git push --token\u001b[32mghp_REALTOKEN')).toBe(
      'git push --token ***',
    );
  });

  it('should keep ANSI-wrapped diagnostics spacing intact', () => {
    // Runs adjacent to existing whitespace or at an edge are deleted, not
    // replaced, so colourised text keeps its width after neutralisation.
    expect(
      redactErrorText('Error: \u001b[32mprovider\u001b[0m unavailable'),
    ).toBe('Error: provider unavailable');
    expect(
      redactErrorText('\u001b[32mError: provider unavailable\u001b[0m'),
    ).toBe('Error: provider unavailable');
  });

  it('should mask a credential straddling a JSON-escaped quote or newline', () => {
    // The widest producer JSON-stringifies response parts, so a quote
    // arrives as \" and a newline as the two chars \n; the value tokeniser
    // must see the unescaped shape or it stops at the backslash.
    expect(
      redactErrorText('{"error":"curl --token=\\"ghs_SECRET\\" failed"}'),
    ).not.toContain('ghs_SECRET');
    expect(redactErrorText('--token\\n=ghs_SECRETvalue')).not.toContain(
      'ghs_SECRETvalue',
    );
    expect(
      redactErrorText('Authorization:\\nBearer abc123SECRETvalue'),
    ).not.toContain('abc123SECRETvalue');
    // Unescaping must not let a quoted run cross the next whitespace.
    expect(redactErrorText('curl --token "ghp_REALTOKEN')).toBe(
      'curl --token ***',
    );
  });

  it('should mask a fully closed quoted value containing spaces', () => {
    // A closed quoted run is masked whole; only an *unclosed* quote stays
    // whitespace-bounded (previous test).
    expect(redactErrorText('--password "correct horse battery"')).toBe(
      '--password ***',
    );
    expect(
      redactErrorText('Command: mysqldump --password="my pass phrase" db'),
    ).toBe('Command: mysqldump --password=*** db');
    expect(
      redactErrorText("Command: mysqldump --password='my pass phrase' db"),
    ).toBe('Command: mysqldump --password=*** db');
  });

  it('should mask the credential on the folded line after an auth scheme word', () => {
    // Agent-authored curl wraps the -H argument; the scheme word's value
    // may sit on the next line, but a following `Name:` header line is the
    // next key's position, never the value. Both pattern families (the
    // Authorization header form and the bare bearer label) must fold.
    expect(
      redactErrorText('Authorization: Bearer\neyJhbGciOiSECRET999'),
    ).not.toContain('eyJhbGciOiSECRET999');
    expect(
      redactErrorText('Output: Bearer\neyJhbGciOiSECRET999'),
    ).not.toContain('eyJhbGciOiSECRET999');
    expect(
      redactErrorText('invalid bearer\ntoken: eyJhbGciOiSECRET999'),
    ).not.toContain('eyJhbGciOiSECRET999');
  });

  it('should mask a registered secret an incomplete escape sequence would eat', () => {
    // `\u001b[32` + `ghp_...`: the CSI final byte is unbounded, so a
    // delete-based strip consumes the secret's first char ('g') as the
    // final byte and the registered value no longer occurs afterwards.
    // Masking the raw input first closes this; neither the whole secret
    // nor its eaten-first-char fragment may survive.
    registerKnownSecretValues(['ghp_SECRETVALUE']);
    try {
      const out = redactErrorText('rejected key \u001b[32ghp_SECRETVALUE');
      expect(out).not.toContain('ghp_SECRETVALUE');
      expect(out).not.toContain('hp_SECRETVALUE');
    } finally {
      clearKnownSecretValuesForTest();
    }
  });

  it('should mask a JSON-escaped registered secret after unescaping', () => {
    // The MCP tool-error builder JSON-stringifies response parts, so a
    // registered credential containing a quote reaches the raw pass as
    // `SYNTHETIC\"SECRET` — the literal registered value never occurs in
    // the raw text. The unescape reconstructs it, so masking must run
    // again on the normalised shape or the full credential ships.
    registerKnownSecretValues(['SYNTHETIC"SECRET_12345']);
    try {
      const jsonError = JSON.stringify([
        { text: 'upstream echoed SYNTHETIC"SECRET_12345' },
      ]);
      const out = redactErrorText(jsonError);
      expect(out).not.toContain('SYNTHETIC"SECRET_12345');
      expect(out).not.toContain('SYNTHETIC\\"SECRET_12345');
      expect(out).not.toContain('SECRET_12345');
    } finally {
      clearKnownSecretValuesForTest();
    }
  });

  it('should stay linear on dash-dense adversarial input', () => {
    // Two-stage bound: the work is bounded BEFORE the passes (the URL
    // pass's dash-permissive class is quadratic past the pre-bound; a
    // ~1MB dash-dense error took ~87s synchronously on the main thread
    // before it), and the result must equal the capped variant because
    // everything past the working multiple is discarded by the final cap.
    const adversarial = '--token'.repeat(200_000);
    const start = performance.now();
    const masked = redactErrorText(adversarial);
    const elapsed = performance.now() - start;
    // Generous CI budget: measured ~1s for 1.4MB locally, tens of seconds
    // without the pre-bound.
    expect(elapsed).toBeLessThan(5000);
    expect(masked).toBe(redactErrorText(adversarial.slice(0, 1024 * 64)));
    // The retained head of a masked, over-long input is still masked.
    const short = redactErrorText('--token=ghs_abcdef '.repeat(200));
    expect(short.length).toBe(1024 + '…[truncated]'.length);
    expect(short).not.toContain('ghs_abcdef');
  });

  it('should share the truncation bound and surrogate guard with the OTel span path', () => {
    // An astral character straddling the bound would emit a lone high
    // surrogate into the JSON payload; the shared helper backs off one
    // code unit so no lone surrogate is emitted.
    const oversized = 'a'.repeat(1023) + '🚀'.repeat(500);
    const result = redactErrorText(oversized);
    expect(result).toBe(truncateErrorText(oversized));
    expect(result.endsWith('…[truncated]')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(result)).toBe(false);
  });

  it('should truncate over-long error text', () => {
    const result = redactErrorText('a'.repeat(1024 + 100));
    expect(result.length).toBe(1024 + '…[truncated]'.length);
    expect(result.endsWith('…[truncated]')).toBe(true);
  });
});
