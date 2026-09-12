/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  buildAcpModelOptions,
  getCurrentAcpModelId,
  isInlineModelOverrideAllowed,
  parseAcpBaseModelId,
  parseAcpModelOption,
  resolveAcpModelOption,
  sanitizeProviderBaseUrl,
} from './acpModelUtils.js';

describe('acpModelUtils', () => {
  it('uses opaque ids only to disambiguate colliding model routes', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'Provider One',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://one.example/v1',
        registryBaseUrl: 'https://one.example/v1',
      },
      {
        id: 'shared-model',
        label: 'Provider Two',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://user:secret@two.example/v1?token=value',
        registryBaseUrl: 'https://user:secret@two.example/v1?token=value',
      },
      {
        id: 'unique-model',
        label: 'Unique',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://three.example/v1',
        registryBaseUrl: 'https://three.example/v1',
      },
    ];

    const options = buildAcpModelOptions(models);
    const [first, second, unique] = options;

    expect(first?.modelId).toMatch(/^qwen-route:v1:/);
    expect(second?.modelId).toMatch(/^qwen-route:v1:/);
    expect(first?.modelId).not.toBe(second?.modelId);
    expect(unique?.modelId).toBe(`unique-model(${AuthType.USE_OPENAI})`);
    expect(options.map((option) => option.modelId).join(' ')).not.toContain(
      'secret',
    );
    expect(resolveAcpModelOption(second!.modelId, models)).toMatchObject({
      modelId: 'shared-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://user:secret@two.example/v1?token=value',
    });
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://user:secret@two.example/v1?token=value',
      ),
    ).toBe(second?.modelId);
    expect(
      buildAcpModelOptions([...models].reverse()).find(
        (option) =>
          option.model.baseUrl ===
          'https://user:secret@two.example/v1?token=value',
      )?.modelId,
    ).toBe(second?.modelId);
  });

  it('keeps opaque ids unique when colliding routes have identical metadata', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'shared-model',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://one.example/v1',
        registryBaseUrl: 'https://one.example/v1',
      },
      {
        id: 'shared-model',
        label: 'shared-model',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://two.example/v1',
        registryBaseUrl: 'https://two.example/v1',
      },
    ];

    const options = buildAcpModelOptions(models);

    expect(new Set(options.map((option) => option.modelId))).toHaveLength(2);
    expect(resolveAcpModelOption(options[0]!.modelId, models)?.baseUrl).toBe(
      'https://one.example/v1',
    );
    expect(resolveAcpModelOption(options[1]!.modelId, models)?.baseUrl).toBe(
      'https://two.example/v1',
    );
    const reversed = buildAcpModelOptions([...models].reverse());
    expect(
      reversed.find(
        (option) => option.model.baseUrl === 'https://one.example/v1',
      )?.modelId,
    ).toBe(options[0]?.modelId);
  });

  it('binds opaque ids to credential-free endpoint identity', () => {
    const makeModels = (suffix: string) => [
      {
        id: 'shared-model',
        label: 'Provider One',
        authType: AuthType.USE_OPENAI,
        baseUrl: `https://one.example/${suffix}`,
        registryBaseUrl: `https://one.example/${suffix}`,
      },
      {
        id: 'shared-model',
        label: 'Provider Two',
        authType: AuthType.USE_OPENAI,
        baseUrl: `https://two.example/${suffix}`,
        registryBaseUrl: `https://two.example/${suffix}`,
      },
    ];

    expect(
      buildAcpModelOptions(makeModels('first')).map((option) => option.modelId),
    ).not.toEqual(
      buildAcpModelOptions(makeModels('changed')).map(
        (option) => option.modelId,
      ),
    );

    const withSecrets = makeModels('first').map((model, index) => ({
      ...model,
      baseUrl: model.baseUrl
        .replace('https://', `https://user:secret-${index}@`)
        .concat(`?token=${index}`),
      registryBaseUrl: model.registryBaseUrl
        .replace('https://', `https://user:secret-${index}@`)
        .concat(`?token=${index}`),
    }));
    expect(
      buildAcpModelOptions(withSecrets).map((option) => option.modelId),
    ).toEqual(
      buildAcpModelOptions(makeModels('first')).map((option) => option.modelId),
    );
  });

  it('rejects colliding routes that differ only by secret URL parts', () => {
    const models = ['one', 'two'].map((token) => ({
      id: 'shared-model',
      label: 'Shared',
      authType: AuthType.USE_OPENAI,
      envKey: 'SHARED_KEY',
      baseUrl: `https://user:${token}@api.example/v1?token=${token}`,
      registryBaseUrl: `https://user:${token}@api.example/v1?token=${token}`,
    }));

    expect(() => buildAcpModelOptions(models)).toThrow(
      'need distinct names, envKey values, or public endpoints',
    );
  });

  it('keeps resolved defaults separate from the registry route key', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'Default Route',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://default.example/v1',
      },
      {
        id: 'shared-model',
        label: 'Explicit Route',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://default.example/v1',
        registryBaseUrl: 'https://default.example/v1',
      },
    ];
    const options = buildAcpModelOptions(models);

    expect(options[0]?.modelId).not.toBe(options[1]?.modelId);
    expect(
      resolveAcpModelOption(options[0]!.modelId, models),
    ).not.toHaveProperty('baseUrl');
    expect(
      getCurrentAcpModelId(options, 'shared-model', AuthType.USE_OPENAI, null),
    ).toBe(options[0]?.modelId);
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://default.example/v1',
      ),
    ).toBe(options[1]?.modelId);
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://outside.example/v1',
      ),
    ).toBe('shared-model');
  });

  it('extracts base model id when string ends with parentheses', () => {
    expect(parseAcpBaseModelId(`qwen3(${AuthType.USE_OPENAI})`)).toBe('qwen3');
  });

  it('does not strip when parentheses are not a trailing suffix', () => {
    expect(parseAcpBaseModelId('qwen3(x) y')).toBe('qwen3(x) y');
  });

  it('parses modelId and validates authType', () => {
    expect(parseAcpModelOption(` qwen3(${AuthType.USE_OPENAI}) `)).toEqual({
      modelId: 'qwen3',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('returns trimmed input as modelId when authType is invalid', () => {
    expect(parseAcpModelOption('qwen3(not-a-real-auth)')).toEqual({
      modelId: 'qwen3(not-a-real-auth)',
    });
  });

  it.each([
    ['not-a-url', 'not-a-url'],
    ['https://api.example/v1', 'https://api.example/v1'],
    ['https://api.example/v1/@scope', 'https://api.example/v1/@scope'],
    ['https://host:99999/path@domain', 'https://host:99999/path@domain'],
    ['https://user@api.example/v1', 'https://api.example/v1'],
    ['https://user@host:99999', 'https://host:99999'],
    ['https://user:secret@api.example/v1', 'https://api.example/v1'],
    [
      'https://user:secret@api.example/v1/@scope',
      'https://api.example/v1/@scope',
    ],
    ['https://user:p ass@api.example/v1', 'https://api.example/v1'],
    [`https://user:p'ass@api.example/v1`, 'https://api.example/v1'],
    ['https://user:p%2Fx@api.example/v1', 'https://api.example/v1'],
    ['https://user:p/x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p?x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p#x@api.example/v1', 'https://api.example/v1'],
    ['https://user:secret@api.example', 'https://api.example'],
    // #8136: pathless URL + prose email shapes. WHATWG misparses these as
    // userinfo; the veto (all-digit port before first whitespace) protects the
    // with-port shape, and the pathless-prose guard protects the no-colon shape.
    [
      'https://api.example:8443 - contact admin@example.com',
      'https://api.example:8443 - contact admin@example.com',
    ],
    [
      'https://api.example - contact admin@example.com',
      'https://api.example - contact admin@example.com',
    ],
    [
      'https://ollama.local - contact admin@example.com',
      'https://ollama.local - contact admin@example.com',
    ],
    // Credentials + pathless + email: strip the credential, keep host + prose.
    [
      'https://user:pass@host.example:8443 - contact admin@example.com',
      'https://host.example:8443 - contact admin@example.com',
    ],
    // Space-in-password: the last '@' within the bounded authority is the real
    // userinfo terminator (the password's '@' precedes it). #8136 R1-1/R1-3.
    [
      'https://user:sec ret@host.example/v1 - contact admin@example.com',
      'https://host.example/v1 - contact admin@example.com',
    ],
    ['https://user:p@ss word@host.example/v1', 'https://host.example/v1'],
    // R1-2 KNOWN RESIDUAL: digit-prefix + space password is locally
    // indistinguishable from a dotless host + port + prose email; the veto
    // fires and the credential leaks. Same tradeoff class as R5-7, pending
    // maintainer sign-off. #8136 R1-2.
    ['https://user:1234 secret@host', 'https://user:1234 secret@host'],
    // #8136 R3: passwords/hostnames the previous host-shaped-char heuristic
    // mishandled. The structural terminator scan resolves these.
    // Password containing '@' (pathless): strip at the LAST '@', not the first.
    ['https://user:p@ss@host', 'https://host'],
    // Underscore-leading host (previously outside HOST_SHAPED_CHAR): strip.
    ['https://user:pass@_host', 'https://_host'],
    // Tab immediately after '@' (WHATWG strips it as userinfo terminator): strip.
    [`https://user:pass@\thost`, 'https://\thost'],
    // Password containing '@' AND whitespace (bounded authority): the last '@'
    // within the bounded authority is the terminator.
    ['https://user:p@ss word@host.example/v1', 'https://host.example/v1'],
    // Whitespace in the password (pathless): the '@' whose following text is a
    // clean hostname is the terminator, so the password's whitespace does not
    // end the scan. #8136 R3-5.
    ['https://user:pass word@host', 'https://host'],
    ['https://user:p@ss word@host', 'https://host'],
    // Unicode whitespace in the password (WHATWG percent-encodes it): strip.
    ['https://user:pa ss@host', 'https://host'],
    // #8136 R3-6: prose with a path - the prose email's '@' must not destroy the
    // host. The pathless prose veto fires regardless of a later delimiter.
    [
      'https://ollama.local - email admin@example.com or check /var/log/qwen',
      'https://ollama.local - email admin@example.com or check /var/log/qwen',
    ],
    // #8136 R4-1: catch-branch (new URL throws) prose '@' after whitespace must
    // not become the strip point - strip the credential, keep host + prose.
    ['https://user:pass@host - ping admin@', 'https://host - ping admin@'],
    // R9-7 KNOWN RESIDUAL: a real host + prose email with a VALID email domain
    // is indistinguishable from a real credential whose terminator is that
    // email's '@' - the prose email's host replaces the real host. (A '%zz'
    // invalid domain makes CLEAN_HOST_AFTER fail and passes spuriously; this
    // pins the real-domain behavior instead.) Same class as R5-1, pending
    // maintainer sign-off.
    ['https://user@host - contact admin@example.com', 'https://example.com'],
    // #8136 R4-3: whitespace-less multi-'@' prose - the FIRST '@' ends the
    // userinfo; the prose email's '@' is not a terminator.
    [
      'https://u:p@h,see(admin@example.com)',
      'https://h,see(admin@example.com)',
    ],
    [
      'https://u:p@h,see(admin@example.com)/x',
      'https://h,see(admin@example.com)/x',
    ],
    // #8136 R4-4/R4-5: backslash - a Windows domain\user:pass@ credential strips
    // as a single userinfo run, while '\' terminates the authority for prose.
    ['https://DOMAIN\\user:pass@proxy', 'https://proxy'],
    ['https://user:pass@host\\path', 'https://host\\path'],
    // #8136 R5-3: an '@' in the password with an underscore host still strips -
    // CLEAN_HOST_AFTER accepts underscore-leading hosts.
    ['https://user:p@ss@_host', 'https://_host'],
    ['https://user:pass@_host:8080', 'https://_host:8080'],
    // #8136 R5-14: URL schemes are case-insensitive; uppercase must still strip.
    ['HTTPS://user:pass@host/v1', 'HTTPS://host/v1'],
    ['HTTP://user:pass@host', 'HTTP://host'],
    // #8136 R5-2: a leading '@' (empty userinfo) does not loop and is a no-op.
    ['https://@host', 'https://host'],
    // #8136 R5-1/R5-7 KNOWN RESIDUAL: a dotted username + digit-prefix password
    // followed by space is locally indistinguishable from a dotted host + port
    // + prose email; the veto fires and the credential leaks. Same tradeoff as
    // R1-2, pending maintainer sign-off.
    ['https://foo.bar:1234 secret@host', 'https://foo.bar:1234 secret@host'],
    // #8136 R1-7: IPv6 bracket + port + prose email must stay unchanged. The
    // prose veto skips the bracket's inner colons and accepts an em-dash/empty
    // port candidate.
    [
      'https://[::1]:8443 — contact admin@example.com',
      'https://[::1]:8443 — contact admin@example.com',
    ],
    [
      'https://ollama.local: please contact admin@example.com',
      'https://ollama.local: please contact admin@example.com',
    ],
    // #8136 R6-1: a port followed by punctuation (`;`/`,`/`.`) + prose email.
    [
      'https://api.example:8443; contact admin@example.com',
      'https://api.example:8443; contact admin@example.com',
    ],
    // #8136 R7-3: a port followed by multiple punctuation chars + prose email.
    [
      'https://api.example:8443,. contact admin@example.com',
      'https://api.example:8443,. contact admin@example.com',
    ],
    // #8136 R7-10: a Unicode (IDN) host is a clean hostname — strip the credential.
    ['https://user:pass@例子.测试/v1', 'https://例子.测试/v1'],
    // #8136 R7-5 KNOWN RESIDUAL: an '@' in the path (npm scoped) with a
    // host:port-shaped authority before it is stripped by the no-'@' fallback
    // (base has the same behavior — the between-run has no whitespace). Same
    // tradeoff class, pending maintainer sign-off.
    [
      'https://registry.example: check /node_modules/@qwen/pkg',
      'https://qwen/pkg',
    ],
    // #8136 R7-1 KNOWN RESIDUAL: a colonless username containing whitespace
    // (`user @host`) is indistinguishable from a prose `host @host` shape;
    // the prose veto fires and it leaks. Pending maintainer sign-off.
    ['https://user @host.example/v1', 'https://user @host.example/v1'],
    // #8136 R5-12: a backslash-free authority with a later prose `a:b@c` is NOT
    // misread as a Windows credential by findAuthorityEnd (R5-12 fixed the
    // windowsCred scan bound). The remaining leak is the R5-1 residual class.
    ['https://user:pass@host a:b@c', 'https://c'],
    // #8136 R5-1/R6-3 KNOWN RESIDUAL: a real terminator in the first '@' with a
    // dotless host after it, followed by prose with an '@host', is
    // indistinguishable from a password containing '@' + a real terminator after
    // whitespace (`user:p@ss word@host` -> `host`). The prose shape's host gets
    // replaced by the prose email's domain; same tradeoff class as R1-2,
    // pending maintainer sign-off.
    [
      'https://user:pass@ollama - contact admin@example.com',
      'https://example.com',
    ],
    [
      'https://user:p@ss word@host.example - contact admin@example.com',
      'https://example.com',
    ],
    // #8136 repro-1 (with-path port + prose email): must stay unchanged - the
    // path bounds the authority, so the prose '@' is never the strip point.
    [
      'https://api.example:8443/v1 - contact admin@example.com',
      'https://api.example:8443/v1 - contact admin@example.com',
    ],
    // #8136 repro-1 verbatim (em-dash as in the issue) also stays unchanged.
    [
      'https://api.example:8443/v1 — contact admin@example.com',
      'https://api.example:8443/v1 — contact admin@example.com',
    ],
    // URL-throwing shapes (invalid %, space in host) + prose email: do not
    // strip the prose '@'. #8136 R2-2.
    [
      'https://api.example%/v1, contact admin@example.com',
      'https://api.example%/v1, contact admin@example.com',
    ],
    [
      'https://my service/v1 - contact admin@example.com',
      'https://my service/v1 - contact admin@example.com',
    ],
  ])('sanitizes provider base URL credentials for %s', (input, expected) => {
    expect(sanitizeProviderBaseUrl(input)).toBe(expected);
  });

  describe('isInlineModelOverrideAllowed', () => {
    const makeConfig = (
      contentGeneratorConfig: unknown,
      available: unknown[],
    ): Config =>
      ({
        getContentGeneratorConfig: () => contentGeneratorConfig,
        getAvailableModelsForAuthType: () => available,
      }) as unknown as Config;

    it('allows a model that matches the active provider identity', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(true);
    });

    it('allows a model when both sides have no baseUrl/envKey (e.g. qwen-oauth)', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-max', authType: AuthType.QWEN_OAUTH },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'qwen-max')).toBe(true);
    });

    it('rejects a same-id model with a different baseUrl', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-b.example/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects a same-id model with a different credential env key', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            envKey: 'PROVIDER_B_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects an unknown model id', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-max', authType: AuthType.QWEN_OAUTH },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'missing')).toBe(false);
    });

    it('does not match selector-only models', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-fast', authType: AuthType.QWEN_OAUTH, fastOnly: true },
        { id: 'qwen-voice', authType: AuthType.QWEN_OAUTH, voiceOnly: true },
        { id: 'qwen-image', authType: AuthType.QWEN_OAUTH, imageOnly: true },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'qwen-fast')).toBe(false);
      expect(isInlineModelOverrideAllowed(config, 'qwen-voice')).toBe(false);
      expect(isInlineModelOverrideAllowed(config, 'qwen-image')).toBe(false);
    });

    it('rejects when no active auth type is available', () => {
      const config = makeConfig(undefined, []);
      expect(isInlineModelOverrideAllowed(config, 'anything')).toBe(false);
    });
  });
});
