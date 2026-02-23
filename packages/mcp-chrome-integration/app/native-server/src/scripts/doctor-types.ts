/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-types.ts
 *
 * Type definitions for the doctor diagnostic script.
 */

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  browser?: string;
}

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorFixAttempt {
  id: string;
  description: string;
  success: boolean;
  error?: string;
}

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: number;
  timestamp: string;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: {
      version: string;
      execPath: string;
    };
    package: {
      name: string;
      version: string;
      rootDir: string;
      distDir: string;
    };
    command: {
      canonical: string;
      aliases: string[];
    };
    nativeHost: {
      hostName: string;
      expectedPort: number;
    };
  };
  fixes: DoctorFixAttempt[];
  checks: DoctorCheckResult[];
  nextSteps: string[];
}

export interface NodeResolutionResult {
  nodePath?: string;
  source?: string;
  version?: string;
  versionError?: string;
  nodePathFile: {
    path: string;
    exists: boolean;
    value?: string;
    valid?: boolean;
    error?: string;
  };
}
