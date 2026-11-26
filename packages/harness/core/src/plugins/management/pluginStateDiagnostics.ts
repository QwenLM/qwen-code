/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import type { SyncAtomicWriteDiagnostic } from '../../utils/fileWriteUtils.js';
import { runLogger } from '../../utils/runLogger.js';

/** 仅关联本地 PID 与 Worker，不引入跨端协议或记录插件身份。 */
export function pluginStateWriteDiagnostics(
  reason: string,
): (event: SyncAtomicWriteDiagnostic) => void {
  return (event) => {
    const detail = {
      file: 'installed_plugins_v2.json',
      reason,
      pid: process.pid,
      threadId,
      ...event,
    };
    if (event.event === 'fallback' || event.event === 'failed') {
      runLogger.warn('[InstalledPlugins] State write', detail);
    } else {
      runLogger.log('[InstalledPlugins] State write', detail);
    }
  };
}

/** 只在读取异常时补充文件元数据，不额外扫描正常读取路径。 */
export function logPluginStateReadFailure(
  filePath: string,
  raw: string | undefined,
  errorCode: string,
): void {
  try {
    let byteLength: number | undefined =
      raw === undefined ? undefined : Buffer.byteLength(raw, 'utf8');
    let mtimeMs: number | undefined;
    try {
      const metadata = statSync(filePath);
      byteLength = metadata.size;
      mtimeMs = metadata.mtimeMs;
    } catch {
      // 文件可能已被其它写入者替换或删除，保留本次读取的长度。
    }
    runLogger.warn('[InstalledPlugins] State read failed', {
      file: 'installed_plugins_v2.json',
      pid: process.pid,
      threadId,
      errorCode,
      byteLength,
      mtimeMs,
      readByteLength:
        raw === undefined ? undefined : Buffer.byteLength(raw, 'utf8'),
      empty: raw === undefined ? undefined : raw.length === 0,
    });
  } catch {
    // 诊断不得改变读取降级语义。
  }
}
