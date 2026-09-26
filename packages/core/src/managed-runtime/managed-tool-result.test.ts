/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ManagedSessionRecordError } from './managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_LIMITS,
  MANAGED_TOOL_RESULT_PROTOCOL,
  MANAGED_TOOL_RESULT_ROUTES,
  ToolResultSegmentLedger,
  isToolResultEnvelopeOf,
  isToolResultManifestSuccessor,
  isToolResultPageAt,
  isToolResultPageSuccessor,
  parseToolResultEnvelope,
  parseToolResultManifest,
  parseToolResultManifestBytes,
  parseToolResultPage,
  parseToolResultPageBytes,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';

type Bytes =
  | { readonly base64: string }
  | { readonly fill: { readonly byte: number; readonly length: number } };

interface Step {
  readonly op: 'publish' | 'seal' | 'prefix';
  readonly request: Record<string, unknown>;
  readonly expected: ToolResultStoreOutcome<unknown>;
}

interface Checked {
  readonly id: string;
  readonly valid: boolean;
}

interface TextCase extends Checked {
  readonly text: string;
  readonly padToBytes?: number;
}

interface RouteCase extends Checked {
  readonly route: 'execute' | 'status' | 'cancel' | 'acknowledge';
  readonly body: unknown;
}

interface FixtureSuite {
  readonly contractVersion: 1;
  readonly toolResult: string;
  readonly kinds: unknown;
  readonly limits: unknown;
  readonly routes: unknown;
  readonly errors: ReadonlyArray<{
    readonly status: number | null;
    readonly code: string | null;
    readonly classification: string;
  }>;
  readonly manifest: Record<string, unknown>;
  readonly pages: readonly unknown[];
  readonly stdout: Bytes;
  readonly manifestCases: ReadonlyArray<Checked & { manifest: unknown }>;
  readonly manifestTextCases: readonly TextCase[];
  readonly pageCases: ReadonlyArray<
    Checked & { page: unknown; repeatSegments?: number }
  >;
  readonly pageTextCases: readonly TextCase[];
  readonly pagePositionCases: ReadonlyArray<
    Checked & {
      manifest: unknown;
      streamIndex: number;
      pageIndex: number;
      page: unknown;
    }
  >;
  readonly revisionCases: ReadonlyArray<
    Checked & { previous: unknown; next: unknown }
  >;
  readonly pageRevisionCases: ReadonlyArray<
    Checked & { previous: unknown; next: unknown }
  >;
  readonly segmentSequences: ReadonlyArray<{
    readonly id: string;
    readonly steps: readonly Step[];
  }>;
  readonly envelopeCases: ReadonlyArray<Checked & { result: unknown }>;
  readonly envelopeManifestCases: ReadonlyArray<
    Checked & { result: unknown; manifest: unknown }
  >;
  readonly requests: Record<RouteCase['route'], Record<string, unknown>>;
  readonly requestCases: readonly RouteCase[];
  readonly responseCases: readonly RouteCase[];
}

interface SchemaDefinition {
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: unknown;
}

/**
 * Fixture cases that the schema accepts although the contract refuses them.
 * JSON Schema cannot state UTF-8 byte limits, NFC, well-formed UTF-16, the
 * 2^63-1 bound readably, unique stream IDs, sums across a list, a count
 * that depends on another field, or a comparison between two fields.
 */
const BEYOND_SCHEMA = {
  manifest: [
    'callId-lone-high-surrogate',
    'callId-not-nfc',
    'callId-over-512-bytes',
    'duplicate-stream-id',
    'executionCallId-lone-high-surrogate',
    'executionCallId-not-nfc',
    'executionCallId-over-512-bytes',
    'generation-over-int64',
    'invocationDigest-lone-high-surrogate',
    'invocationDigest-not-nfc',
    'invocationDigest-over-512-bytes',
    'missing-range-after-a-gap',
    'missing-range-empty',
    'missing-range-inside-stored-bytes',
    'missing-range-reversed',
    'no-pages-for-stored-bytes',
    'page-longer-than-its-segments-allow',
    'page-shorter-than-its-segment-count',
    'pages-add-up-to-less',
    'pages-add-up-to-more',
    'pages-for-an-empty-stream',
    'resource-body-digest-mismatch',
    'resource-body-length-mismatch',
    'sessionId-lone-high-surrogate',
    'sessionId-not-nfc',
    'sessionId-over-512-bytes',
    'tenantId-lone-high-surrogate',
    'tenantId-lone-low-surrogate',
    'tenantId-not-nfc',
    'tenantId-over-512-bytes',
    'tenantId-two-byte-over-512-bytes',
    'turnId-lone-high-surrogate',
    'turnId-not-nfc',
    'turnId-over-512-bytes',
  ],
  page: ['ends-past-the-largest-count', 'first-ordinal-past-the-last'],
  envelope: ['manifest-not-nfc-id'],
};

const contractDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts',
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-tool-result-v1.fixtures.json'),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-tool-result-v1.schema.json'),
    'utf8',
  ),
) as { readonly $id: string; readonly $defs: Record<string, SchemaDefinition> };
const ajv = new Ajv2020({ strict: true });
const validateSuite = ajv.compile(schema);

function schemaAccepts(definition: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`The schema has no ${definition} definition.`);
  }
  return validate(value) as boolean;
}

function bytesOf(spec: Bytes): Buffer {
  return 'base64' in spec
    ? Buffer.from(spec.base64, 'base64')
    : Buffer.alloc(spec.fill.length, spec.fill.byte);
}

function textOf(fixture: TextCase): Buffer {
  const text = Buffer.from(fixture.text, 'utf8');
  if (fixture.padToBytes === undefined) return text;
  if (fixture.padToBytes < text.byteLength) {
    throw new Error(`${fixture.id} is longer than its padding.`);
  }
  return Buffer.concat([
    text,
    Buffer.alloc(fixture.padToBytes - text.byteLength, 0x20),
  ]);
}

function pageOf(fixture: FixtureSuite['pageCases'][number]): unknown {
  if (fixture.repeatSegments === undefined) return fixture.page;
  const page = fixture.page as { segments: unknown[] };
  if (page.segments.length !== 1) {
    throw new Error(`${fixture.id} must repeat exactly one segment.`);
  }
  return {
    ...page,
    segments: Array.from(
      { length: fixture.repeatSegments },
      () => page.segments[0],
    ),
  };
}

function throwsContractError(parse: () => unknown): boolean {
  try {
    parse();
    return false;
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return true;
    throw error;
  }
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((child) => isDeepFrozen(child))
  );
}

/** A copy of `value` whose `field` reads `first` once, then `later`. */
function withChangingField(
  value: Record<string, unknown>,
  field: string,
  first: unknown,
  later: unknown,
): { readonly value: Record<string, unknown>; reads(): number } {
  let reads = 0;
  const copy = { ...value };
  Object.defineProperty(copy, field, {
    enumerable: true,
    get: () => {
      reads++;
      return reads === 1 ? first : later;
    },
  });
  return { value: copy, reads: () => reads };
}

describe('Managed tool result contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    expect(validateSuite(fixtures)).toBe(true);
    expect(validateSuite.errors).toBeNull();
  });

  it('closes every record definition of the schema', () => {
    const open: string[] = [];
    for (const [name, definition] of Object.entries(schema.$defs)) {
      if (definition.properties === undefined) continue;
      const optional = sortedKeys(definition.properties).filter(
        (key) => !definition.required?.includes(key),
      );
      if (
        definition.additionalProperties !== false ||
        !(definition.required ?? []).every(
          (key) => key in (definition.properties ?? {}),
        ) ||
        optional.some(
          (key) =>
            ![
              'afterSequence',
              'error',
              'lastSequence',
              'result',
              'type',
            ].includes(key),
        )
      ) {
        open.push(name);
      }
    }

    expect(open).toEqual([]);
  });

  it('pins the protocol token, kinds, limits and routes', () => {
    expect(fixtures.contractVersion).toBe(1);
    expect(fixtures.toolResult).toBe(MANAGED_TOOL_RESULT_PROTOCOL);
    expect(fixtures.kinds).toStrictEqual({ ...MANAGED_TOOL_RESULT_KINDS });
    expect(fixtures.limits).toStrictEqual({ ...MANAGED_TOOL_RESULT_LIMITS });
    expect(fixtures.routes).toStrictEqual(
      MANAGED_TOOL_RESULT_ROUTES.map((route) => ({ ...route })),
    );
  });

  it('uses each case id once in each list', () => {
    for (const list of [
      fixtures.manifestCases,
      fixtures.manifestTextCases,
      fixtures.pageCases,
      fixtures.pageTextCases,
      fixtures.pagePositionCases,
      fixtures.revisionCases,
      fixtures.pageRevisionCases,
      fixtures.segmentSequences,
      fixtures.envelopeCases,
      fixtures.envelopeManifestCases,
      fixtures.requestCases,
      fixtures.responseCases,
    ]) {
      const ids = list.map((fixture) => fixture.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it.each(fixtures.manifestCases)('parses the $id manifest case', (fixture) => {
    if (fixture.valid) {
      const manifest = parseToolResultManifest(fixture.manifest);

      expect(manifest).toStrictEqual(fixture.manifest);
      expect(isDeepFrozen(manifest)).toBe(true);
    } else {
      expect(
        throwsContractError(() => parseToolResultManifest(fixture.manifest)),
      ).toBe(true);
    }
  });

  it.each(fixtures.manifestTextCases)(
    'parses the $id manifest body',
    (fixture) => {
      const parse = () => parseToolResultManifestBytes(textOf(fixture));

      if (fixture.valid) {
        expect(parse()).toStrictEqual(fixtures.manifest);
      } else {
        expect(throwsContractError(parse)).toBe(true);
      }
    },
  );

  it.each(fixtures.pageCases)('parses the $id page case', (fixture) => {
    const page = pageOf(fixture);
    if (fixture.valid) {
      expect(parseToolResultPage(page)).toStrictEqual(page);
    } else {
      expect(throwsContractError(() => parseToolResultPage(page))).toBe(true);
    }
  });

  it.each(fixtures.pageTextCases)('parses the $id page body', (fixture) => {
    const parse = () => parseToolResultPageBytes(textOf(fixture));

    if (fixture.valid) {
      expect(parse()).toStrictEqual(fixtures.pages[0]);
    } else {
      expect(throwsContractError(parse)).toBe(true);
    }
  });

  it.each(fixtures.pagePositionCases)(
    'places the $id page',
    ({ manifest, streamIndex, pageIndex, page, valid }) => {
      expect(isToolResultPageAt(manifest, streamIndex, pageIndex, page)).toBe(
        valid,
      );
    },
  );

  it.each(fixtures.revisionCases)(
    'checks the $id revision',
    ({ previous, next, valid }) => {
      expect(isToolResultManifestSuccessor(previous, next)).toBe(valid);
    },
  );

  it.each(fixtures.pageRevisionCases)(
    'checks the $id page revision',
    ({ previous, next, valid }) => {
      expect(isToolResultPageSuccessor(previous, next)).toBe(valid);
    },
  );

  it.each(fixtures.segmentSequences)(
    'replays the $id segment sequence',
    ({ steps }) => {
      const ledger = new ToolResultSegmentLedger();
      for (const step of steps) {
        const request =
          step.op === 'publish'
            ? {
                ...step.request,
                bytes: bytesOf(step.request['bytes'] as Bytes),
              }
            : step.request;

        expect(ledger[step.op](request)).toStrictEqual(step.expected);
      }
    },
  );

  it.each(fixtures.envelopeCases)('parses the $id result', (fixture) => {
    if (fixture.valid) {
      const result = parseToolResultEnvelope(fixture.result);

      expect(result).toStrictEqual(fixture.result);
      // Response parts stay the caller's; everything else is frozen.
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.responseParts)).toBe(true);
      expect(isDeepFrozen(result.capture)).toBe(true);
      expect(isDeepFrozen(result.error)).toBe(true);
    } else {
      expect(
        throwsContractError(() => parseToolResultEnvelope(fixture.result)),
      ).toBe(true);
    }
  });

  it.each(fixtures.envelopeManifestCases)(
    'matches the $id result with its manifest',
    ({ result, manifest, valid }) => {
      expect(isToolResultEnvelopeOf(result, manifest)).toBe(valid);
    },
  );

  it('agrees with the schema except where the schema cannot state a rule', () => {
    const disagreements = {
      manifest: new Set<string>(),
      page: new Set<string>(),
      envelope: new Set<string>(),
    };
    // A case the module accepts and the schema refuses would put the
    // schema in the wrong.
    const acceptedButSchemaInvalid: string[] = [];
    const compare = (
      list: keyof typeof disagreements,
      fixture: Checked,
      schemaValid: boolean,
    ) => {
      if (schemaValid !== fixture.valid) {
        disagreements[list].add(fixture.id);
        if (fixture.valid) acceptedButSchemaInvalid.push(fixture.id);
      }
    };
    for (const fixture of fixtures.manifestCases) {
      compare('manifest', fixture, schemaAccepts('manifest', fixture.manifest));
    }
    for (const fixture of fixtures.pageCases) {
      compare('page', fixture, schemaAccepts('page', pageOf(fixture)));
    }
    for (const fixture of fixtures.envelopeCases) {
      compare('envelope', fixture, schemaAccepts('result', fixture.result));
    }

    expect(acceptedButSchemaInvalid).toEqual([]);
    expect({
      manifest: [...disagreements.manifest].sort(),
      page: [...disagreements.page].sort(),
      envelope: [...disagreements.envelope].sort(),
    }).toEqual(BEYOND_SCHEMA);
  });

  it('decides every Tool v3 request and response case by the schema', () => {
    const wrong = [
      ...fixtures.requestCases.filter(
        (fixture) =>
          schemaAccepts(`${fixture.route}Request`, fixture.body) !==
          fixture.valid,
      ),
      ...fixtures.responseCases.filter(
        (fixture) =>
          schemaAccepts(`${fixture.route}Response`, fixture.body) !==
          fixture.valid,
      ),
    ].map((fixture) => fixture.id);

    expect(wrong).toEqual([]);
    for (const route of MANAGED_TOOL_RESULT_ROUTES) {
      expect(
        schemaAccepts(`${route.key}Request`, fixtures.requests[route.key]),
      ).toBe(true);
    }
  });

  it('keeps the canonical manifest, pages and bytes consistent', () => {
    const stdout = bytesOf(fixtures.stdout);
    const manifest = parseToolResultManifest(fixtures.manifest);
    const stream = manifest.contents[0];
    const pages = fixtures.pages.map((page) => parseToolResultPage(page));
    const segments = pages.flatMap((page) => page.segments);
    let offset = 0;
    const slices = segments.map((segment) => {
      const slice = stdout.subarray(offset, offset + segment.byteLength);
      offset += segment.byteLength;
      return slice;
    });

    expect(stream.byteLength).toBe(stdout.byteLength);
    expect(stream.digest).toBe(sha256(stdout));
    expect(offset).toBe(stdout.byteLength);
    expect(slices.map(sha256)).toEqual(segments.map((each) => each.digest));
    pages.forEach((page, index) => {
      expect(isToolResultPageAt(fixtures.manifest, 0, index, page)).toBe(true);
    });
    const seal = fixtures.segmentSequences
      .find((sequence) => sequence.id === 'publishes-and-seals-a-stream')
      ?.steps.find((step) => step.op === 'seal');
    expect(seal?.expected).toStrictEqual({
      status: 'ok',
      result: {
        segmentCount: segments.length,
        byteLength: stdout.byteLength,
        digest: sha256(stdout),
      },
    });
  });

  it('lists every store refusal in the error table', () => {
    const table = new Set(
      fixtures.errors
        .filter((error) => error.status === null)
        .map((error) => error.code),
    );
    const codes = new Set(
      fixtures.segmentSequences.flatMap((sequence) =>
        sequence.steps.flatMap((step) =>
          step.expected.status === 'refused' ? [step.expected.code] : [],
        ),
      ),
    );

    expect([...codes].sort()).toEqual([...table].sort());
  });

  it('keeps the largest single stream within the manifest limit', () => {
    const longest = 'x'.repeat(MANAGED_TOOL_RESULT_LIMITS.maxIdBytes);
    const segmentBytes = MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes;
    const pageBytes =
      segmentBytes * MANAGED_TOOL_RESULT_LIMITS.maxSegmentsPerPage;
    const pages = Array.from(
      { length: MANAGED_TOOL_RESULT_LIMITS.maxPagesPerStream },
      () => ({
        ref: {
          resourceId: longest,
          kind: MANAGED_TOOL_RESULT_KINDS.page,
          schemaVersion: 1,
          byteLength: MANAGED_TOOL_RESULT_LIMITS.maxPageBytes,
          digest: 'f'.repeat(64),
        },
        segmentCount: MANAGED_TOOL_RESULT_LIMITS.maxSegmentsPerPage,
        byteLength: pageBytes,
      }),
    );
    const manifest = {
      ...fixtures.manifest,
      tenantId: longest,
      sessionId: longest,
      turnId: longest,
      executionCallId: longest,
      callId: longest,
      invocationDigest: longest,
      bindingGeneration: '9223372036854775807',
      captureId: 'c'.repeat(128),
      signal: null,
      exitCode: -2147483648,
      contents: [
        {
          streamId: 's'.repeat(128),
          role: 'stdout',
          mimeType: `application/${'x'.repeat(243)}`,
          state: 'sealed',
          byteLength: pageBytes * pages.length,
          digest: 'f'.repeat(64),
          missingRanges: [],
          body: { pages },
        },
      ],
    };
    const largestPage = {
      ...(fixtures.pages[0] as object),
      captureId: 'c'.repeat(128),
      streamId: 's'.repeat(128),
      firstOrdinal: 0,
      offset: 9007199254740990 - pageBytes,
      segments: Array.from(
        { length: MANAGED_TOOL_RESULT_LIMITS.maxSegmentsPerPage },
        () => ({ byteLength: segmentBytes, digest: 'f'.repeat(64) }),
      ),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const pageBytesOnWire = Buffer.from(JSON.stringify(largestPage), 'utf8');

    expect(parseToolResultManifestBytes(manifestBytes).contents).toHaveLength(
      1,
    );
    expect(manifestBytes.byteLength).toBeLessThanOrEqual(
      MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes,
    );
    expect(parseToolResultPageBytes(pageBytesOnWire).segments).toHaveLength(
      MANAGED_TOOL_RESULT_LIMITS.maxSegmentsPerPage,
    );
    expect(pageBytesOnWire.byteLength).toBeLessThanOrEqual(
      MANAGED_TOOL_RESULT_LIMITS.maxPageBytes,
    );
  });

  it('reads each manifest field once, so the checked value is kept', () => {
    for (const field of sortedKeys(fixtures.manifest)) {
      const changing = withChangingField(
        fixtures.manifest,
        field,
        fixtures.manifest[field],
        field === 'contents' ? [] : 'changed',
      );

      expect(parseToolResultManifest(changing.value)).toStrictEqual(
        fixtures.manifest,
      );
      expect(changing.reads()).toBe(1);
    }
  });

  it('refuses objects that are not plain JSON objects', () => {
    const callable = Object.assign(() => undefined, fixtures.manifest);
    const inherited = Object.assign(
      Object.create({ inherited: true }) as object,
      fixtures.manifest,
    );

    expect(throwsContractError(() => parseToolResultManifest(callable))).toBe(
      true,
    );
    expect(throwsContractError(() => parseToolResultManifest(inherited))).toBe(
      true,
    );
  });

  it('stores a copy of the published bytes', () => {
    const ledger = new ToolResultSegmentLedger();
    const bytes = Buffer.from('abc');
    const request = {
      captureId: 'capture-01',
      streamId: 'stdout',
      ordinal: 0,
      bytes,
    };

    expect(ledger.publish(request).status).toBe('ok');
    bytes.write('xyz');
    expect(ledger.publish({ ...request, bytes: Buffer.from('abc') })).toEqual({
      status: 'ok',
      result: { ordinal: 0, byteLength: 3, digest: sha256(Buffer.from('abc')) },
    });
  });

  it('keeps each ledger its own segments', () => {
    const first = new ToolResultSegmentLedger();
    const second = new ToolResultSegmentLedger();
    const request = {
      captureId: 'capture-01',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('abc'),
    };

    expect(first.publish(request).status).toBe('ok');
    expect(
      second.publish({ ...request, bytes: Buffer.from('xyz') }).status,
    ).toBe('ok');
  });
});
