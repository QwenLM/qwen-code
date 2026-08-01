/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { realRunWsl, listDistros, type RunWsl } from './wsl.js';
import {
  up,
  down,
  status,
  readPairingCode,
  type UpResult,
  type StatusResult,
} from './launcherClient.js';
import { readEnv, writeEnv, type ProviderEnv } from './envConfig.js';
import { streamLogs, type LogStream } from './logs.js';
import { readAppConfig, writeAppConfig } from './appConfig.js';
import { nextPollState, type PollState } from './statusPoll.js';

const POLL_INTERVAL_MS = 3000;

const CHANNELS = [
  'up',
  'down',
  'status',
  'pairingCode',
  'listDistros',
  'getConfig',
  'saveConfig',
  'setDistro',
  'startLogs',
  'stopLogs',
] as const;

/**
 * Wire the `window.launcher` IPC surface (see preload.ts) to the Task-1/2
 * modules for a single BrowserWindow. Never logs or persists the pairing
 * code / OPENAI_API_KEY — those pass through in-memory only, over IPC to the
 * renderer, and on disk only inside the WSL-side `.env` (envConfig.ts).
 */
export function registerIpc(win: BrowserWindow): void {
  let config = readAppConfig();
  let currentDistro = config.distro;
  let logStream: LogStream | undefined;
  let pollState: PollState = {
    running: false,
    url: undefined,
    lastError: undefined,
  };

  const runWsl = (): RunWsl => realRunWsl(currentDistro);

  const sendIfAlive = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const pollOnce = async (): Promise<void> => {
    try {
      const s = await status(runWsl());
      pollState = nextPollState(pollState, s);
    } catch (err) {
      pollState = {
        ...pollState,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
    sendIfAlive('status', pollState);
  };

  const pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  void pollOnce();

  ipcMain.handle('up', (): Promise<UpResult> => up(runWsl()));
  ipcMain.handle('down', () => down(runWsl()));
  ipcMain.handle('status', (): Promise<StatusResult> => status(runWsl()));
  ipcMain.handle('pairingCode', () => readPairingCode(runWsl()));
  ipcMain.handle('listDistros', () => listDistros());
  ipcMain.handle('getConfig', async () => {
    const env = await readEnv(runWsl());
    return { ...env, distro: currentDistro };
  });
  ipcMain.handle('saveConfig', (_e, env: ProviderEnv) =>
    writeEnv(runWsl(), env),
  );
  ipcMain.handle('setDistro', (_e, distro: string) => {
    currentDistro = distro;
    // Re-read from disk before merging: `main.ts` may have persisted window
    // bounds into launcher-app.json since our stale in-memory `config` was
    // captured at registerIpc() time, and we must not clobber them.
    config = { ...readAppConfig(), distro };
    writeAppConfig(config);
    return { ok: true };
  });
  ipcMain.handle('startLogs', () => {
    logStream?.stop();
    logStream = streamLogs(currentDistro, (line) => sendIfAlive('log', line));
    return { ok: true };
  });
  ipcMain.handle('stopLogs', () => {
    logStream?.stop();
    logStream = undefined;
    return { ok: true };
  });

  win.on('closed', () => {
    clearInterval(pollTimer);
    logStream?.stop();
    logStream = undefined;
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  });
}
