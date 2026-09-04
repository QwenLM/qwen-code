interface PreflightCell {
  kind: string;
  detail?: Record<string, unknown>;
}

interface EnvCell {
  kind: string;
  name: string;
  present?: boolean;
  value?: string;
}

export interface SystemInfo {
  nodeVersion: string;
  npmVersion: string;
  authSource: string;
  platform: string;
  arch: string;
  sandbox: string;
  proxy: string;
  memoryUsage: string;
}

export function collectSystemInfo(
  preflight: { cells: PreflightCell[] } | null,
  env: { cells: EnvCell[] } | null,
): SystemInfo {
  const info: SystemInfo = {
    nodeVersion: '',
    npmVersion: '',
    authSource: '',
    platform: '',
    arch: '',
    sandbox: '',
    proxy: '',
    memoryUsage: '',
  };

  if (preflight) {
    for (const cell of preflight.cells) {
      const d = cell.detail as Record<string, string> | undefined;
      if (cell.kind === 'node_version' && d?.version) {
        info.nodeVersion = d.version;
      } else if (cell.kind === 'npm' && d?.version) {
        info.npmVersion = String(d.version).replace(/^npm\s*/i, '');
      } else if (cell.kind === 'auth' && d?.source) {
        info.authSource = d.source;
      }
    }
  }

  if (env) {
    for (const cell of env.cells) {
      if (cell.kind === 'platform') {
        info.platform = cell.name;
        if (cell.value) info.arch = cell.value;
      } else if (cell.kind === 'sandbox' && cell.name === 'SANDBOX') {
        info.sandbox = cell.value || '';
      } else if (cell.kind === 'proxy' && cell.present && cell.value) {
        info.proxy = `${cell.name}: ${cell.value}`;
      } else if (cell.kind === 'memory' && cell.value) {
        info.memoryUsage = cell.value;
      }
    }
  }

  return info;
}
