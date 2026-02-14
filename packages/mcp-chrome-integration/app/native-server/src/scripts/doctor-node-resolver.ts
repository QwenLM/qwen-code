/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-node-resolver.ts
 *
 * Node.js resolution logic for the doctor diagnostic script.
 * Mirrors the resolution logic from run_host.sh and run_host.bat.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  canExecute,
  expandTilde,
  pickLatestVersionDir,
  stringifyError,
  stripOuterQuotes,
} from './doctor-utils';
import { NodeResolutionResult } from './doctor-types';

/**
 * Resolve Node.js executable using a priority-based search order.
 * Priority: CHROME_MCP_NODE_PATH > node_path.txt > relative path > Volta > asdf > fnm > nvm > common paths > PATH
 */
export function resolveNodeCandidate(distDir: string): NodeResolutionResult {
  const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePathFilePath = path.join(distDir, 'node_path.txt');

  const nodePathFile: NodeResolutionResult['nodePathFile'] = {
    path: nodePathFilePath,
    exists: fs.existsSync(nodePathFilePath),
  };

  const consider = (
    source: string,
    rawCandidate?: string,
  ): { nodePath: string; source: string } | null => {
    if (!rawCandidate) return null;
    let candidate = expandTilde(stripOuterQuotes(rawCandidate));

    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        candidate = path.join(candidate, nodeFileName);
      }
    } catch {
      // ignore
    }

    if (canExecute(candidate)) {
      return { nodePath: candidate, source };
    }
    return null;
  };

  // Priority 0: CHROME_MCP_NODE_PATH
  const fromEnv = consider(
    'CHROME_MCP_NODE_PATH',
    process.env.CHROME_MCP_NODE_PATH,
  );
  if (fromEnv) {
    return { ...fromEnv, nodePathFile };
  }

  // Priority 1: node_path.txt
  if (nodePathFile.exists) {
    try {
      const content = fs.readFileSync(nodePathFilePath, 'utf8').trim();
      nodePathFile.value = content;
      const fromFile = consider('node_path.txt', content);
      nodePathFile.valid = Boolean(fromFile);
      if (fromFile) {
        return { ...fromFile, nodePathFile };
      }
    } catch (e) {
      nodePathFile.error = stringifyError(e);
      nodePathFile.valid = false;
    }
  }

  // Priority 1.5: Relative path fallback (mirrors run_host.sh/bat)
  // Unix: ../../../bin/node (from dist/)
  // Windows: ..\..\..\node.exe (from dist/, no bin/ subdirectory)
  const relativeNodePath =
    process.platform === 'win32'
      ? path.resolve(distDir, '..', '..', '..', nodeFileName)
      : path.resolve(distDir, '..', '..', '..', 'bin', nodeFileName);
  const fromRelative = consider('relative', relativeNodePath);
  if (fromRelative) return { ...fromRelative, nodePathFile };

  // Priority 2: Volta
  const voltaHome = process.env.VOLTA_HOME || path.join(os.homedir(), '.volta');
  const fromVolta = consider(
    'volta',
    path.join(voltaHome, 'bin', nodeFileName),
  );
  if (fromVolta) return { ...fromVolta, nodePathFile };

  // Priority 3: asdf (cross-platform)
  const asdfDir = process.env.ASDF_DATA_DIR || path.join(os.homedir(), '.asdf');
  const asdfNodejsDir = path.join(asdfDir, 'installs', 'nodejs');
  const latestAsdf = pickLatestVersionDir(asdfNodejsDir);
  if (latestAsdf) {
    const fromAsdf = consider(
      'asdf',
      path.join(latestAsdf, 'bin', nodeFileName),
    );
    if (fromAsdf) return { ...fromAsdf, nodePathFile };
  }

  // Priority 4: fnm (cross-platform, Windows uses different layout)
  const fnmDir = process.env.FNM_DIR || path.join(os.homedir(), '.fnm');
  const fnmVersionsDir = path.join(fnmDir, 'node-versions');
  const latestFnm = pickLatestVersionDir(fnmVersionsDir);
  if (latestFnm) {
    const fnmNodePath =
      process.platform === 'win32'
        ? path.join(latestFnm, 'installation', nodeFileName)
        : path.join(latestFnm, 'installation', 'bin', nodeFileName);
    const fromFnm = consider('fnm', fnmNodePath);
    if (fromFnm) return { ...fromFnm, nodePathFile };
  }

  // Priority 5: NVM (Unix only)
  if (process.platform !== 'win32') {
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    const nvmDefaultAlias = path.join(nvmDir, 'alias', 'default');
    try {
      if (fs.existsSync(nvmDefaultAlias)) {
        const stat = fs.lstatSync(nvmDefaultAlias);
        const maybeVersion = stat.isSymbolicLink()
          ? fs.readlinkSync(nvmDefaultAlias).trim()
          : fs.readFileSync(nvmDefaultAlias, 'utf8').trim();
        const fromDefault = consider(
          'nvm-default',
          path.join(nvmDir, 'versions', 'node', maybeVersion, 'bin', 'node'),
        );
        if (fromDefault) return { ...fromDefault, nodePathFile };
      }
    } catch {
      // ignore
    }

    const latestNvm = pickLatestVersionDir(
      path.join(nvmDir, 'versions', 'node'),
    );
    if (latestNvm) {
      const fromNvm = consider(
        'nvm-latest',
        path.join(latestNvm, 'bin', 'node'),
      );
      if (fromNvm) return { ...fromNvm, nodePathFile };
    }
  }

  // Priority 6: Common paths
  const commonPaths =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.ProgramFiles || 'C:\\Program Files',
            'nodejs',
            'node.exe',
          ),
          path.join(
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            'nodejs',
            'node.exe',
          ),
          path.join(
            process.env.LOCALAPPDATA || '',
            'Programs',
            'nodejs',
            'node.exe',
          ),
        ].filter((p) => path.isAbsolute(p))
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const common of commonPaths) {
    const resolved = consider('common', common);
    if (resolved) return { ...resolved, nodePathFile };
  }

  // Priority 7: PATH
  const pathEnv = process.env.PATH || '';
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = stripOuterQuotes(rawDir);
    if (!dir) continue;
    const candidate = path.join(dir, nodeFileName);
    if (canExecute(candidate)) {
      return { nodePath: candidate, source: 'PATH', nodePathFile };
    }
  }

  return { nodePathFile };
}

/**
 * Get the version of a Node.js executable.
 */
export function getNodeVersion(nodePath: string): string | undefined {
  try {
    return execFileSync(nodePath, ['-v'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}
