/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SDK_NODE_STUBBED_EXPORTERS,
  isStubbedSdkNodeExporterImport,
} from '../sdk-node-exporter-stub.js';

// Importer paths as esbuild reports them, per OS. sdk-node lives one level up
// from the exporter package inside node_modules; the decision must hold
// regardless of the path separator (Windows is the ⚠️ platform in the matrix).
const POSIX_SDK_NODE_IMPORTER =
  '/repo/node_modules/@opentelemetry/sdk-node/build/src/sdk.js';
const WINDOWS_SDK_NODE_IMPORTER =
  'C:\\repo\\node_modules\\@opentelemetry\\sdk-node\\build\\src\\sdk.js';
const POSIX_OWN_MODULE_IMPORTER =
  '/repo/packages/core/src/telemetry/sdk-exporters-grpc.ts';
const WINDOWS_OWN_MODULE_IMPORTER =
  'C:\\repo\\packages\\core\\src\\telemetry\\sdk-exporters-http.ts';

describe('SDK_NODE_STUBBED_EXPORTERS', () => {
  it('matches the OTLP exporter packages across every transport', () => {
    for (const signal of ['trace', 'logs', 'metrics']) {
      for (const transport of ['grpc', 'http', 'proto']) {
        expect(
          SDK_NODE_STUBBED_EXPORTERS.test(
            `@opentelemetry/exporter-${signal}-otlp-${transport}`,
          ),
        ).toBe(true);
      }
    }
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/exporter-zipkin'),
    ).toBe(true);
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/exporter-prometheus'),
    ).toBe(true);
  });

  it('does not match non-exporter or unrelated packages', () => {
    expect(SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/sdk-node')).toBe(
      false,
    );
    expect(SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/api')).toBe(false);
    // Subpath imports must not match — the anchor is end-of-string.
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test(
        '@opentelemetry/exporter-trace-otlp-grpc/build/src/index.js',
      ),
    ).toBe(false);
  });
});

describe('isStubbedSdkNodeExporterImport', () => {
  it('stubs a stubbed exporter imported by sdk-node on POSIX and Windows', () => {
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-trace-otlp-grpc',
        POSIX_SDK_NODE_IMPORTER,
      ),
    ).toBe(true);
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-metrics-otlp-http',
        WINDOWS_SDK_NODE_IMPORTER,
      ),
    ).toBe(true);
  });

  it('leaves the real package for our own protocol modules', () => {
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-trace-otlp-grpc',
        POSIX_OWN_MODULE_IMPORTER,
      ),
    ).toBe(false);
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-metrics-otlp-http',
        WINDOWS_OWN_MODULE_IMPORTER,
      ),
    ).toBe(false);
  });

  it('does not stub non-exporter packages even when sdk-node imports them', () => {
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/otlp-transformer',
        POSIX_SDK_NODE_IMPORTER,
      ),
    ).toBe(false);
  });

  it('is safe against a missing or empty importer', () => {
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-trace-otlp-grpc',
        undefined,
      ),
    ).toBe(false);
    expect(
      isStubbedSdkNodeExporterImport(
        '@opentelemetry/exporter-trace-otlp-grpc',
        '',
      ),
    ).toBe(false);
  });
});
