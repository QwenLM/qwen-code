/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import * as https from 'node:https';

export type HttpClient = typeof http | typeof https;

export function clientForUrl(url: string): HttpClient {
  const protocol = new URL(url).protocol.toLowerCase();
  if (protocol === 'https:') {
    return https;
  }
  if (protocol === 'http:') {
    return http;
  }
  throw new Error(`Unsupported URL protocol: ${protocol}`);
}
