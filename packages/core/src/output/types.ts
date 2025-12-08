/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum InputFormat {
  TEXT = 'text',
  STREAM_JSON = 'stream-json',
}

export enum OutputFormat {
  TEXT = 'text',
  JSON = 'json',
  STREAM_JSON = 'stream-json',
}

export interface JsonError {
  type: string;
  message: string;
  code?: string | number;
}

export interface JsonOutput {
  response?: string;
  error?: JsonError;
}
