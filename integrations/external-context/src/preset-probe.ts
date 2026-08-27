/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only preset selection tool.
 *
 * A `mem0` configuration asks the administrator for one thing they cannot read
 * off their own deployment: which wire contract it implements. Origin,
 * credential, and scope are facts they hold; `preset` is a judgement about a
 * service that may be self-hosted, vendor-packaged, or pinned to an old
 * release. This probe answers it from evidence instead, by running the
 * selected preset against the endpoint and reporting what came back.
 *
 * It only ever issues search requests and one `GET /openapi.json`. It never
 * writes, and it never prints the credential.
 */

import { readBoundedBody, validateProviderBaseUrl } from './http-client.js';
import {
  findInvalidMem0Scope,
  getMem0Preset,
  mem0ScopeViolationMessage,
} from './mem0-presets.js';
import { Mem0CompatibleAdapter } from './providers.js';
import { MEM0_PRESET_IDS, type Mem0PresetId } from './types.js';
import type { Mem0CompatibleProviderConfig } from './types.js';

const PROBE_QUERY = 'deployment policy';
const PROBE_LIMIT = 5;
const UNKNOWN_FIELD = '__qwen_preset_probe_unused__';

export interface PresetProbeOptions {
  preset: Mem0PresetId;
  origin: string;
  basePath?: string;
  allowInsecureHttp?: boolean;
  scope: Mem0CompatibleProviderConfig['scope'];
  credential: string;
  signal: AbortSignal;
}

export interface ProbeRequestOutcome {
  status: number;
  /** Sorted, de-duplicated result identifiers, or undefined when unreadable. */
  ids?: readonly string[];
  detail?: string;
}

export type UnknownFieldPolicy = 'ignored' | 'rejected' | 'inconclusive';

export type PresetProbeVerdict =
  | 'preset-mismatch'
  | 'empty-corpus'
  | 'dual-placement-safe'
  | 'dual-placement-unsafe'
  | 'dual-placement-divergent'
  | 'already-dual-placement';

export interface PresetProbeReport {
  preset: Mem0PresetId;
  searchUrl: string;
  declaredSearchFields?: readonly string[];
  declaredAdditionalProperties?: string;
  /** The real adapter's own search, so item parsing is exercised too. */
  baseline: { ok: true; itemCount: number } | { ok: false; reason: string };
  unknownFieldPolicy: UnknownFieldPolicy;
  placements?: {
    filtersOnly: ProbeRequestOutcome;
    rootOnly: ProbeRequestOutcome;
    both: ProbeRequestOutcome;
  };
  verdict: PresetProbeVerdict;
}

export async function runPresetProbe(
  options: PresetProbeOptions,
): Promise<PresetProbeReport> {
  const violation = findInvalidMem0Scope(options);
  if (violation !== undefined) {
    throw new Error(mem0ScopeViolationMessage(options.preset, violation));
  }
  const preset = getMem0Preset(options.preset);
  const origin = validateProviderBaseUrl(options.origin, {
    allowInsecureHttp: options.allowInsecureHttp,
    allowInsecureHttpHint: true,
  });
  const basePath = (options.basePath ?? '').replace(/\/$/u, '');
  const searchUrl = new URL(origin);
  searchUrl.pathname = `${basePath}${preset.search.path}`;

  const config: Mem0CompatibleProviderConfig = {
    type: 'mem0',
    preset: options.preset,
    endpoint: {
      origin: options.origin,
      basePath,
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
    },
    credentialEnv: 'MEM0_PRESET_PROBE_CREDENTIAL',
    credential: options.credential,
    scope: options.scope,
  };

  const schema = await readSearchSchema(origin, basePath, options);

  // The adapter, not a re-implementation: a preset that reaches the endpoint
  // but whose items the parser discards is still the wrong preset, and only
  // the real search path shows that.
  let baseline: PresetProbeReport['baseline'];
  try {
    const items = await new Mem0CompatibleAdapter(config).search({
      query: PROBE_QUERY,
      limit: PROBE_LIMIT,
      signal: options.signal,
    });
    baseline = { ok: true, itemCount: items.length };
  } catch (error) {
    baseline = {
      ok: false,
      reason: error instanceof Error ? error.message : 'unknown error',
    };
  }

  const scopeFields = [
    ['userId', 'user_id'],
    ['agentId', 'agent_id'],
    ['appId', 'app_id'],
  ] as const;
  const activeScope = scopeFields
    .filter(([key]) => options.scope[key] !== undefined)
    .filter(([key]) => preset.scope[key].search !== 'omit')
    .map(([key, field]) => [field, options.scope[key] as string] as const);

  const request = (extra: Record<string, unknown>) =>
    probeSearch(searchUrl, preset.authentication, options, {
      query: PROBE_QUERY,
      [preset.search.limitField]: PROBE_LIMIT,
      ...preset.search.fixedBody,
      ...extra,
    });

  const filtersBody = { filters: Object.fromEntries(activeScope) };
  const rootBody = Object.fromEntries(activeScope);

  const unknown = await request({ ...filtersBody, [UNKNOWN_FIELD]: 1 });
  const unknownFieldPolicy: UnknownFieldPolicy =
    unknown.status === 200
      ? 'ignored'
      : unknown.status === 422 || unknown.status === 400
        ? 'rejected'
        : 'inconclusive';

  const alreadyDual = scopeFields.some(
    ([key]) => preset.scope[key].search === 'body-and-filters',
  );
  if (alreadyDual) {
    return {
      preset: options.preset,
      searchUrl: searchUrl.toString(),
      ...schema,
      baseline,
      unknownFieldPolicy,
      verdict: 'already-dual-placement',
    };
  }

  const placements = {
    filtersOnly: await request(filtersBody),
    rootOnly: await request(rootBody),
    both: await request({ ...rootBody, ...filtersBody }),
  };

  return {
    preset: options.preset,
    searchUrl: searchUrl.toString(),
    ...schema,
    baseline,
    unknownFieldPolicy,
    placements,
    verdict: decideVerdict(baseline, placements),
  };
}

function decideVerdict(
  baseline: PresetProbeReport['baseline'],
  placements: NonNullable<PresetProbeReport['placements']>,
): PresetProbeVerdict {
  const { filtersOnly, both } = placements;
  if (!baseline.ok || filtersOnly.status !== 200) {
    return 'preset-mismatch';
  }
  // An empty corpus makes every placement agree by being equally empty, which
  // reads as a pass and is not one.
  if ((filtersOnly.ids?.length ?? 0) === 0) {
    return 'empty-corpus';
  }
  if (both.status !== 200) {
    return 'dual-placement-unsafe';
  }
  return sameIds(both.ids, filtersOnly.ids)
    ? 'dual-placement-safe'
    : 'dual-placement-divergent';
}

function sameIds(a?: readonly string[], b?: readonly string[]): boolean {
  return a !== undefined && b !== undefined && a.join(',') === b.join(',');
}

async function readSearchSchema(
  origin: URL,
  basePath: string,
  options: PresetProbeOptions,
): Promise<{
  declaredSearchFields?: readonly string[];
  declaredAdditionalProperties?: string;
}> {
  const url = new URL(origin);
  url.pathname = `${basePath}/openapi.json`;
  let parsed: unknown;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: options.signal,
    });
    if (!response.ok) {
      return {};
    }
    parsed = JSON.parse(await readBoundedBody(response));
  } catch {
    return {};
  }
  const schemas = pick(pick(parsed, 'components'), 'schemas');
  const search =
    pick(schemas, 'SearchRequest') ?? pick(schemas, 'SearchMemoryRequest');
  const properties = pick(search, 'properties');
  if (properties === undefined) {
    return {};
  }
  // `additionalProperties` is most often the boolean `false`, which is the
  // whole signal, so it is read as a raw value rather than as a nested object.
  const additional =
    search === undefined ? undefined : search['additionalProperties'];
  return {
    declaredSearchFields: Object.keys(properties),
    declaredAdditionalProperties:
      search !== undefined && Object.hasOwn(search, 'additionalProperties')
        ? JSON.stringify(additional)
        : '(unset)',
  };
}

function pick(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

async function probeSearch(
  url: URL,
  authentication: ReturnType<typeof getMem0Preset>['authentication'],
  options: PresetProbeOptions,
  body: Record<string, unknown>,
): Promise<ProbeRequestOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(authentication === 'x-api-key'
          ? { 'x-api-key': options.credential }
          : { authorization: `Token ${options.credential}` }),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: options.signal,
    });
  } catch (error) {
    return {
      status: 0,
      detail: error instanceof Error ? error.message : 'request failed',
    };
  }

  let text: string;
  try {
    text = await readBoundedBody(response);
  } catch {
    return { status: response.status, detail: 'response body was unreadable' };
  }
  if (response.status !== 200) {
    // Upstream error bodies name the rejected field, which is the whole point
    // of the probe. Bounded because it is printed to a terminal.
    return {
      status: response.status,
      detail: text.slice(0, 300).replace(/\s+/gu, ' '),
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const results =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['results']
        : undefined;
    if (!Array.isArray(results)) {
      return { status: 200, detail: 'response had no results array' };
    }
    const ids = [
      ...new Set(
        results
          .map((item) =>
            typeof item === 'object' && item !== null
              ? (item as Record<string, unknown>)['id']
              : undefined,
          )
          .filter((id): id is string => typeof id === 'string'),
      ),
    ].sort();
    return { status: 200, ids };
  } catch {
    return { status: 200, detail: 'response was not valid JSON' };
  }
}

const VERDICT_TEXT: Readonly<Record<PresetProbeVerdict, readonly string[]>> = {
  'preset-mismatch': [
    'MISMATCH: this preset does not work against this endpoint.',
    'Try another preset, or check the base path and credential. The status and',
    'body above name the field or route the deployment rejected.',
  ],
  'empty-corpus': [
    'INCONCLUSIVE: the baseline search matched no memories.',
    'Every placement then agrees by being equally empty, which is not a pass.',
    'Re-run with a scope whose corpus holds at least one memory.',
  ],
  'dual-placement-safe': [
    'SAFE: sending identity at the request root as well as under filters',
    'returns the same memories as the preset does today. This preset can move',
    'to body-and-filters, which also works on builds that read only the root.',
  ],
  'dual-placement-unsafe': [
    'UNSAFE: the dual-placement request was rejected. Keep this preset as it',
    'is; the deployment declares a strict schema without a root identity field.',
  ],
  'dual-placement-divergent': [
    'DIVERGENT: dual placement returned a different result set than the preset',
    'sends today. Do not change the placement; investigate how this deployment',
    'combines the two positions before trusting either.',
  ],
  'already-dual-placement': [
    'This preset already sends identity in both positions, so there is nothing',
    'to compare. The baseline above is the result that matters.',
  ],
};

export function renderPresetProbeReport(report: PresetProbeReport): string {
  const lines = [
    '',
    `Preset:   ${report.preset}`,
    `Endpoint: ${report.searchUrl}  (read-only)`,
    '',
    '1. Declared schema',
  ];
  if (report.declaredSearchFields) {
    lines.push(
      `   search fields:        ${report.declaredSearchFields.join(', ')}`,
    );
    lines.push(
      `   additionalProperties: ${report.declaredAdditionalProperties}`,
    );
  } else {
    lines.push('   not served - the probes below are the evidence');
  }

  lines.push('', '2. This preset, through the real adapter');
  lines.push(
    report.baseline.ok
      ? `   search returned ${report.baseline.itemCount} usable item(s)`
      : `   search failed: ${report.baseline.reason}`,
  );

  lines.push('', '3. Unknown-field policy');
  lines.push(
    {
      ignored: '   unknown fields are ignored',
      rejected: '   unknown fields are rejected by a strict schema',
      inconclusive: '   inconclusive',
    }[report.unknownFieldPolicy],
  );

  if (report.placements) {
    lines.push('', '4. Scope placement');
    for (const [label, key] of [
      ['filters only (current)', 'filtersOnly'],
      ['request root only', 'rootOnly'],
      ['both', 'both'],
    ] as const) {
      const outcome = report.placements[key];
      const summary =
        outcome.ids !== undefined
          ? `ids=[${outcome.ids.join(',')}]`
          : (outcome.detail ?? '');
      lines.push(
        `   ${label.padEnd(24)} HTTP ${String(outcome.status).padEnd(4)} ${summary}`,
      );
    }
  }

  lines.push(
    '',
    'Verdict',
    ...VERDICT_TEXT[report.verdict].map((l) => `   ${l}`),
    '',
  );
  return lines.join('\n');
}

export function parsePresetProbeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Omit<PresetProbeOptions, 'signal'> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== undefined && flag.startsWith('--')) {
      const next = argv[index + 1];
      args.set(
        flag.slice(2),
        next !== undefined && !next.startsWith('--') ? next : 'true',
      );
    }
  }

  const preset = args.get('preset');
  const origin = args.get('origin');
  if (preset === undefined || !isPresetId(preset)) {
    throw new Error(`--preset must be one of: ${MEM0_PRESET_IDS.join(', ')}`);
  }
  if (origin === undefined) {
    throw new Error('--origin is required.');
  }
  const credentialEnv = args.get('credential-env') ?? 'MEM0_API_KEY';
  const credential = env[credentialEnv];
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new Error(`${credentialEnv} must hold the provider credential.`);
  }

  const scope: Mem0CompatibleProviderConfig['scope'] = {};
  for (const [flag, key] of [
    ['user-id', 'userId'],
    ['agent-id', 'agentId'],
    ['app-id', 'appId'],
  ] as const) {
    const value = args.get(flag);
    if (value !== undefined) {
      scope[key] = value;
    }
  }

  return {
    preset,
    origin,
    ...(args.has('base-path') ? { basePath: args.get('base-path') } : {}),
    ...(args.get('allow-insecure-http') === 'true'
      ? { allowInsecureHttp: true }
      : {}),
    scope,
    credential,
  };
}

function isPresetId(value: string): value is Mem0PresetId {
  return (MEM0_PRESET_IDS as readonly string[]).includes(value);
}
