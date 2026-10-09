/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ModDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export type ModDiscoveryStatus = 'absent' | 'declared' | 'invalid';

export interface ModDescriptor {
  root: string;
  discovery: ModDiscoveryStatus;
  entry?: string;
  userConfig?: unknown;
  types?: unknown;
  dependencies?: unknown;
  diagnostics: ModDiagnostic[];
}

export interface ModRequirement {
  kind: 'event' | 'api' | 'element';
  name: string;
  stage: string;
  file?: string;
  line?: number;
  column?: number;
  matcher?: string;
  hasCatch?: boolean;
}

export interface ModValidationReport {
  schemaVersion: 1;
  target: string;
  discovery: ModDescriptor['discovery'];
  static: {
    status: 'not-checked' | 'valid' | 'invalid' | 'incomplete';
    complete: boolean;
  };
  runtime: 'unavailable';
  entry?: string;
  files: string[];
  requirements: ModRequirement[];
  diagnostics: ModDiagnostic[];
}
