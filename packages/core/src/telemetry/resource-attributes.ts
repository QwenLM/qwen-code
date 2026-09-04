/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';

/**
 * Resource attribute keys that cannot be overridden from any user-controlled
 * source (env var or settings.json). Attempts to set these are dropped with
 * a warning, and the runtime-injected value is used instead.
 *
 * - `service.version` — telemetry integrity (no version spoofing).
 * - `session.id` — runtime-injected; allowing user override would either bypass
 *   the metric cardinality toggle (Resource attrs auto-attach to every metric
 *   data point) or silently shadow the real session id.
 *
 * `service.name` is NOT in this set — it follows its own precedence chain
 * (see design doc §4.2 for details).
 */
export const RESERVED_RESOURCE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'service.version',
  'session.id',
]);

/**
 * Optional accumulator the helpers in this module push human-readable
 * diagnostic strings into when they drop or rewrite user input. Each helper
 * also calls `diag.warn` for the debug log; the accumulator is what lets the
 * SDK emit a one-time user-visible summary at telemetry startup (see
 * `sdk.ts:initializeTelemetry`).
 */
export type ResourceAttributeWarnings = string[];

function warn(msg: string, warnings?: ResourceAttributeWarnings): void {
  diag.warn(msg);
  warnings?.push(msg);
}

/**
 * Parse the standard OpenTelemetry `OTEL_RESOURCE_ATTRIBUTES` env var format.
 *
 * Format: `key1=value1,key2=value2` with both keys and values URL-encoded per
 * the OTel spec / W3C Baggage:
 * https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
 *
 * Behavior on malformed input is permissive — bad pairs are skipped with a
 * `diag.warn` and parsing continues. The goal is to never block telemetry
 * startup on a single malformed value.
 *
 * Duplicate keys: last-write-wins, matching the OTel SDK reference behavior.
 *
 * Note on warn visibility: `diag.warn` routes to the debug log file
 * (`~/.qwen/log/otel-*.log`), not console — see PR #3986. The SDK emits a
 * single console summary at startup when this list is non-empty so users
 * notice silent drops without scanning the debug log.
 */
export function parseOtelResourceAttributes(
  raw: string | undefined,
  warnings?: ResourceAttributeWarnings,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) {
      // Common cause: literal comma in value (split treats it as a separator).
      // Per OTel spec, commas in values must be percent-encoded as %2C.
      warn(
        `Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "${trimmed}" ` +
          `(hint: percent-encode literal commas as %2C)`,
        warnings,
      );
      continue;
    }
    const rawKey = trimmed.slice(0, idx).trim();
    if (!rawKey) continue; // silent skip: "=value" or " =value"
    const valueRaw = trimmed.slice(idx + 1).trim();
    // Keys are also percent-encoded per the OTel/W3C spec. If we did not
    // decode them, a key like `service%2Eversion` would land verbatim and
    // miss the RESERVED filter — collectors that decode keys downstream
    // could then resurrect `service.version` and bypass reserved-key
    // protection. Decode key + value identically.
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES key "${rawKey}", using raw key`,
        warnings,
      );
      key = rawKey;
    }
    let value: string;
    try {
      value = decodeURIComponent(valueRaw);
    } catch {
      warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES for key "${key}", using raw value`,
        warnings,
      );
      value = valueRaw;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Strip RESERVED keys from a user-provided attribute map and warn the user.
 * Mutates the input object and returns it.
 */
export function stripReservedResourceAttributes(
  attrs: Record<string, string>,
  source: 'OTEL_RESOURCE_ATTRIBUTES' | 'settings.telemetry.resourceAttributes',
  warnings?: ResourceAttributeWarnings,
): Record<string, string> {
  for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
    if (k in attrs) {
      warn(`${source} cannot override reserved key "${k}"; ignoring`, warnings);
      delete attrs[k];
    }
  }
  return attrs;
}

/**
 * Defensive runtime coercion for settings-provided resource attributes.
 *
 * TypeScript types and the settings JSON schema both demand string values,
 * but raw `settings.json` can be hand-edited and arrive with any value type.
 * Drop non-string values with a warning rather than letting them flow into
 * OTel (which would either reject the entire Resource at export or silently
 * coerce them depending on SDK version).
 *
 * Also trims keys and drops empty/whitespace-only keys, matching
 * `parseOtelResourceAttributes`. A settings.json with `{"  ": "x"}` or
 * `{"team ": "y"}` would otherwise produce malformed Resource attributes.
 */
export function coerceStringResourceAttributes(
  raw: unknown,
  warnings?: ResourceAttributeWarnings,
): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn(
      'settings.telemetry.resourceAttributes must be an object; ignoring',
      warnings,
    );
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) {
      warn(
        'settings.telemetry.resourceAttributes has an empty or whitespace-only key; ignoring',
        warnings,
      );
      continue;
    }
    if (typeof v === 'string') {
      out[key] = v;
    } else {
      warn(
        `settings.telemetry.resourceAttributes value for "${key}" must be a string (got ${typeof v}); ignoring`,
        warnings,
      );
    }
  }
  return out;
}
