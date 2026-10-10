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
  for (const value of fixtures.valid.filter(
    (candidate: { name: string }) =>
      candidate.name === 'execute' || candidate.name === 'execute-read-only',
  )) {
    for (const locator of fixtures.intentLocatorCases) {
      it(`${value.name} ${locator.accepted ? 'accepts' : 'refuses'} ${locator.name}`, () => {
        const changed = structuredClone(value.response);
        changed.evidence.grant.intent = locator.intent;
        if (locator.authorization) {
          changed.head.revision = locator.authorization.revision;
          changed.head.sequence = locator.authorization.sequence;
          for (const target of [changed.evidence, changed.evidence.grant]) {
            target.authorizationRevision = locator.authorization.revision;
            target.authorizationSequence = locator.authorization.sequence;
          }
        }
        const read = () =>
          readCsiNativeResponse(changed, readCsiNativeRequest(value.request));
        if (locator.accepted) expect(read()).toEqual(changed);
        else expect(read).toThrow();
      });
    }
    it(`${value.name} refuses the legacy resource grant field`, () => {
      const changed = structuredClone(value.response);
      changed.evidence.grant.intentRef = fixtures.intentLocatorCases.find(
        (candidate: { name: string }) =>
          candidate.name === 'resource-shaped locator',
      ).intent;
      delete changed.evidence.grant.intent;
      expect(() =>
        readCsiNativeResponse(changed, readCsiNativeRequest(value.request)),
      ).toThrow();
    });
    it(`${value.name} refuses a duplicate locator key before validation`, () => {
      const bytes = Buffer.from(
        JSON.stringify(value.response).replace(
          '"intent":{"revision":7,',
          '"intent":{"revision":1,"revision":7,',
        ),
      );
      expect(() =>
        parseManagedCsiFileJson(bytes, CSI_NATIVE_RESPONSE_LIMIT),
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
