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
 * Parse the standard OpenTelemetry `OTEL_RESOURCE_ATTRIBUTES` env var format.
 *
 * Format: `key1=value1,key2=value2` with values URL-encoded per the OTel spec
 * (https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/).
 *
 * Behavior on malformed input is permissive — bad pairs are skipped with a
 * `diag.warn` and parsing continues. The goal is to never block telemetry
 * startup on a single malformed value.
 *
 * Duplicate keys: last-write-wins, matching the OTel SDK reference behavior.
 *
 * Note on warn visibility: `diag.warn` routes to the debug log file
 * (`~/.qwen/log/otel-*.log`), not console — see PR #3986. If a user-provided
 * attribute appears not to take effect, that log is the place to look.
 */
export function parseOtelResourceAttributes(
  raw: string | undefined,
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
      diag.warn(
        `Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "${trimmed}" ` +
          `(hint: percent-encode literal commas as %2C)`,
      );
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    if (!key) continue; // silent skip: "=value" or " =value"
    const valueRaw = trimmed.slice(idx + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(valueRaw);
    } catch {
      diag.warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES for key "${key}", using raw value`,
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
): Record<string, string> {
  for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
    if (k in attrs) {
      diag.warn(`${source} cannot override reserved key "${k}"; ignoring`);
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
 */
export function coerceStringResourceAttributes(
  raw: unknown,
): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    diag.warn(
      'settings.telemetry.resourceAttributes must be an object; ignoring',
    );
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else {
      diag.warn(
        `settings.telemetry.resourceAttributes value for "${k}" must be a string (got ${typeof v}); ignoring`,
      );
    }
  }
  return out;
}
