import { describe, expect, it, vi } from 'vitest';
import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite';

const proxyPaths = [
  '/health',
  '/capabilities',
  '/daemon',
  '/session',
  '/sessions',
  '/workspace',
  '/permission',
  '/file',
  '/stat',
  '/list',
  '/glob',
];

async function loadConfig(daemonUrl?: string): Promise<UserConfig> {
  const previousDaemonUrl = process.env.QWEN_DAEMON_URL;
  if (daemonUrl) {
    process.env.QWEN_DAEMON_URL = daemonUrl;
  } else {
    delete process.env.QWEN_DAEMON_URL;
  }

  try {
    vi.resetModules();
    const mod = (await import('../../vite.config')) as {
      default: UserConfigExport;
    };
    const env: ConfigEnv = {
      command: 'serve',
      mode: 'development',
      isPreview: false,
      isSsrBuild: false,
    };
    const config =
      typeof mod.default === 'function' ? mod.default(env) : mod.default;
    return (await config) as UserConfig;
  } finally {
    if (previousDaemonUrl === undefined) {
      delete process.env.QWEN_DAEMON_URL;
    } else {
      process.env.QWEN_DAEMON_URL = previousDaemonUrl;
    }
  }
}

function proxyTarget(config: UserConfig, path: string) {
  const proxy = config.server?.proxy;
  const entry = proxy?.[path];
  if (typeof entry === 'string') return entry;
  return entry?.target;
}

describe('web Vite config', () => {
  it('proxies all daemon endpoints used by the web cockpit', async () => {
    const config = await loadConfig();
    expect(Object.keys(config.server?.proxy ?? {})).toEqual(proxyPaths);
  });

  it('uses the default daemon target when no environment override is set', async () => {
    const config = await loadConfig();
    for (const path of proxyPaths) {
      expect(proxyTarget(config, path)).toBe('http://127.0.0.1:4170');
    }
  });

  it('uses QWEN_DAEMON_URL as the daemon target', async () => {
    const config = await loadConfig('http://127.0.0.1:4171');
    for (const path of proxyPaths) {
      expect(proxyTarget(config, path)).toBe('http://127.0.0.1:4171');
    }
  });
});
