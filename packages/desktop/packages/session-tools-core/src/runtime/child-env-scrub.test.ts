import { describe, expect, it } from 'bun:test';
import {
  collectSensitiveChildEnvKeys,
  createSanitizedChildEnv,
} from './child-env-scrub.ts';

describe('createSanitizedChildEnv', () => {
  it('tracks the core daemon/internal Qwen secret patterns', () => {
    const keys = collectSensitiveChildEnvKeys({
      QWEN_SERVER_TOKEN: 'server-token',
      QWEN_DAEMON_TOKEN: 'daemon-token',
      QWEN_CODE_SIMPLE: '1',
      QWEN_CUSTOM_API_KEY_EXAMPLE: 'custom-key',
      QWEN_API_KEY: 'provider-key',
      OPENAI_API_KEY: 'provider-key',
      SAFE_VAR: 'ok',
    });

    expect(keys).toEqual(
      new Set([
        'QWEN_SERVER_TOKEN',
        'QWEN_DAEMON_TOKEN',
        'QWEN_CODE_SIMPLE',
        'QWEN_CUSTOM_API_KEY_EXAMPLE',
      ]),
    );
  });

  it('removes desktop MCP credential denylist and daemon-internal keys', () => {
    const env = createSanitizedChildEnv(
      {
        SAFE_VAR: 'ok',
        LLM_API_KEY: 'llm-key',
        QWEN_API_KEY: 'qwen-key',
        AWS_ACCESS_KEY_ID: 'aws-id',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_SESSION_TOKEN: 'aws-session',
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'gh-token',
        GOOGLE_API_KEY: 'google-key',
        STRIPE_SECRET_KEY: 'stripe-key',
        NPM_TOKEN: 'npm-token',
        QWEN_SERVER_TOKEN: 'server-token',
        QWEN_DAEMON_TOKEN: 'daemon-token',
        QWEN_CODE_SIMPLE: '1',
        QWEN_CUSTOM_API_KEY_EXAMPLE: 'custom-key',
      },
      {
        LLM_API_KEY: 'override-llm-key',
        QWEN_DAEMON_TOKEN: 'override-daemon-token',
        EXTRA_VAR: 'extra',
      },
    );

    expect(env.SAFE_VAR).toBe('ok');
    expect(env.EXTRA_VAR).toBe('extra');
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.QWEN_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.QWEN_SERVER_TOKEN).toBeUndefined();
    expect(env.QWEN_DAEMON_TOKEN).toBeUndefined();
    expect(env.QWEN_CODE_SIMPLE).toBeUndefined();
    expect(env.QWEN_CUSTOM_API_KEY_EXAMPLE).toBeUndefined();
  });

  it('removes mixed-case credential names on Windows', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const env = createSanitizedChildEnv(
        {
          safe_var: 'ok',
          aws_secret_access_key: 'aws-secret',
          Github_Token: 'github-token',
          npm_token: 'npm-token',
          qwen_daemon_token: 'daemon-token',
        },
        {
          Qwen_Api_Key: 'qwen-key',
          Extra_Var: 'extra',
        },
      );

      expect(env.safe_var).toBe('ok');
      expect(env.Extra_Var).toBe('extra');
      expect(env.aws_secret_access_key).toBeUndefined();
      expect(env.Github_Token).toBeUndefined();
      expect(env.npm_token).toBeUndefined();
      expect(env.qwen_daemon_token).toBeUndefined();
      expect(env.Qwen_Api_Key).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!);
    }
  });
});
