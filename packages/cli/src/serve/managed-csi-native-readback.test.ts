/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-native-readback-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import {
  CSI_NATIVE_REQUEST_LIMIT,
  CSI_NATIVE_RESPONSE_LIMIT,
  readCsiNativeRequest,
  readCsiNativeResponse,
} from './managed-csi-native-readback.js';

describe('private CSI native readback', () => {
  for (const value of fixtures.valid) {
    it(`accepts the shared ${value.name} response and original opaque bytes`, () => {
      const request = readCsiNativeRequest(value.request);
      const parsed = parseManagedCsiFileJson(
        Buffer.from(JSON.stringify(value.response)),
        CSI_NATIVE_RESPONSE_LIMIT,
      );
      expect(readCsiNativeResponse(parsed, request)).toEqual(value.response);
    });
    for (const field of Object.keys(value.request)) {
      it(`refuses a missing ${value.name} request ${field}`, () => {
        const changed: Record<string, unknown> = structuredClone(value.request);
        delete changed[field];
        expect(() => readCsiNativeRequest(changed)).toThrow();
      });
    }
    for (const field of Object.keys(value.response)) {
      it(`refuses a missing ${value.name} response ${field}`, () => {
        const changed: Record<string, unknown> = structuredClone(
          value.response,
        );
        delete changed[field];
        expect(() =>
          readCsiNativeResponse(changed, readCsiNativeRequest(value.request)),
        ).toThrow();
      });
    }
  }
  for (const value of fixtures.invalid) {
    it(`refuses shared ${value.name}`, () => {
      expect(() =>
        readCsiNativeResponse(
          value.response,
          readCsiNativeRequest(value.request),
        ),
      ).toThrow();
    });
  }
  it('refuses duplicates, noncanonical counters and request overflow before decoding', () => {
    for (const value of fixtures.invalidJson)
      expect(() =>
        parseManagedCsiFileJson(Buffer.from(value), CSI_NATIVE_REQUEST_LIMIT),
      ).toThrow();
    expect(() =>
      parseManagedCsiFileJson(
        Buffer.from('{}'.padEnd(CSI_NATIVE_REQUEST_LIMIT + 1)),
        CSI_NATIVE_REQUEST_LIMIT,
      ),
    ).toThrow();
    expect(() =>
      parseManagedCsiFileJson(Buffer.from([0xff]), CSI_NATIVE_REQUEST_LIMIT),
    ).toThrow();
  });
});
