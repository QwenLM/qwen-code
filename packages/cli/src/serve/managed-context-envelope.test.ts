/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv exposes draft 2020-12 through this documented entry point.
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_CONTEXT_BOOT_VERSION,
  MANAGED_CONTEXT_PROTOCOL,
  MANAGED_CONTEXT_READY_VERSION,
  MANAGED_CONTEXT_ROUTES,
  ManagedContextInstallations,
  checkManagedContextAttestation,
  createManagedContextAttestationResponse,
  createManagedContextReady,
  isManagedContextReady,
  parseManagedContextBoot,
  type ManagedContextAttestationResponse,
  type ManagedContextBoot,
  type ManagedContextOutcome,
  type ManagedContextReady,
  type ManagedContextReceipt,
} from './managed-context-envelope.js';
import { createHash } from 'node:crypto';
import {
  CONTEXT_BINDING_DOMAIN_TAG,
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';

interface InstallationStep {
  readonly request: unknown;
  readonly expected: ManagedContextOutcome<ManagedContextReceipt>;
}

interface FixtureSuite {
  readonly contractVersion: 1;
  readonly managedContext: string;
  readonly bootVersion: number;
  readonly readyVersion: number;
  readonly routes: readonly unknown[];
  readonly errors: ReadonlyArray<{
    readonly status: number;
    readonly code: string | null;
    readonly classification: string;
  }>;
  readonly boot: ManagedContextBoot;
  readonly ready: ManagedContextReady;
  readonly attestationResponse: ManagedContextAttestationResponse;
  readonly bootCases: ReadonlyArray<{
    readonly id: string;
    readonly boot: unknown;
    readonly valid: boolean;
  }>;
  readonly readyCases: ReadonlyArray<{
    readonly id: string;
    readonly ready: unknown;
    readonly valid: boolean;
  }>;
  readonly attestationCases: ReadonlyArray<{
    readonly id: string;
    readonly body: unknown;
    readonly expected: ManagedContextOutcome<ManagedContextAttestationResponse>;
  }>;
  readonly installationSequences: ReadonlyArray<{
    readonly id: string;
    readonly steps: readonly InstallationStep[];
  }>;
}

interface SchemaDefinition {
  readonly required: readonly string[];
  readonly properties: Record<string, unknown>;
  readonly additionalProperties: unknown;
}

const INVALID_BOOT_MESSAGE = 'Managed context boot document is invalid.';
const INVALID = {
  status: 400,
  code: 'managed_runtime_attestation_invalid',
} as const;
const CLOSED_DEFINITIONS = [
  'bootV2',
  'readyV2',
  'attestationRequestV3',
  'attestationResponseV3',
  'installationRequest',
  'binding',
  'receipt',
] as const;
/**
 * Fixture cases that the schema accepts although the contract refuses them,
 * listed by their base case. JSON Schema cannot state UTF-8 byte or UTF-16
 * unit limits, a digest over the binding, or a comparison with the boot
 * document. The 2^63-1 bound and the normal form of a directory are left to
 * the fixtures because patterns could state them only unreadably.
 */
const BEYOND_SCHEMA = {
  boot: [
    'astral-mount-root-over-4096-bytes',
    'generation-over-int64',
    'two-byte-mount-root-over-4096-bytes',
  ],
  ready: [
    'incarnation-other-case',
    'instance-other-case',
    'lease-other-case',
    'other-epoch',
    'other-incarnation',
    'other-instance',
    'other-lease',
  ],
  attestation: [
    'astral-mount-root-over-4096-bytes',
    'generation-over-int64',
    'two-byte-mount-root-over-4096-bytes',
  ],
  installation: [
    'after-a-digest-refusal-keeps-the-operation#1',
    'after-a-digest-refusal-keeps-the-session#1',
    'after-a-digest-refusal-replays-the-receipt#1',
    'astral-session-over-512-units',
    'binding-directory-dot-segment',
    'binding-directory-parent-inside',
    'binding-empty-segment',
    'binding-generation-over-int64',
    'binding-not-normalized',
    'binding-parent-segment',
    'binding-revision-over-int64',
    'binding-trailing-slash',
    'checks-the-digest-before-an-operation-reused-by-another-session#1',
    'checks-the-digest-before-the-workspace',
    'digest-of-another-binding',
    'keeps-no-session-after-a-digest-refusal#0',
    'keeps-no-state-after-a-binding-rule-refusal#0',
    'keeps-no-state-after-a-digest-refusal#0',
    'keeps-no-state-after-a-digest-refusal-for-another-session#0',
  ],
};
/** The keywords of a closed record definition, and no others. */
const CLOSED_KEYWORDS = [
  'additionalProperties',
  'properties',
  'required',
  'type',
];

const contractDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contracts',
);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-context-v1.fixtures.json'),
    'utf8',
  ),
) as FixtureSuite;
const schema = JSON.parse(
  fs.readFileSync(
    path.join(contractDirectory, 'managed-context-v1.schema.json'),
    'utf8',
  ),
) as {
  readonly $id: string;
  readonly $defs: Record<string, SchemaDefinition>;
};
const ajv = new Ajv2020({ strict: true });
const validateSuite = ajv.compile(schema);

function schemaAccepts(definition: string, value: unknown): boolean {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`The schema has no ${definition} definition.`);
  }
  return validate(value) as boolean;
}

const boot = fixtures.boot;
const readyPort = Number(new URL(fixtures.ready.url).port);
const firstInstallation = fixtures.installationSequences.find(
  (sequence) => sequence.id === 'installs-a-context',
)?.steps[0];
if (!firstInstallation || firstInstallation.expected.status !== 200) {
  throw new Error('The installs-a-context fixture must install a context.');
}
const installationRequest = firstInstallation.request as Record<
  string,
  unknown
> & { readonly binding: Record<string, unknown> };

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/**
 * The W0a digest over a binding's seven fields as given, checking no rule;
 * undefined where a naive encoder has no single answer.
 */
function rawDigest(binding: Record<string, unknown>): string | undefined {
  const hash = createHash('sha256');
  for (const item of [
    CONTEXT_BINDING_DOMAIN_TAG,
    binding['tenantId'],
    binding['workspaceId'],
    binding['workspaceGeneration'],
    binding['storageId'],
    binding['cwdRelative'],
    binding['contextConfigRef'],
    binding['contextRevision'],
  ]) {
    const text = typeof item === 'number' ? String(item) : item;
    if (typeof text !== 'string' || /[\ud800-\udfff]/u.test(text)) {
      return undefined;
    }
    const bytes = Buffer.from(text, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * The case an order case derives from: the malformed step of an
 * after-an-installation sequence, or an other-identity or other-workspace
 * variant. Every field in which it differs from its base case is itself
 * valid, so the schema judges both alike.
 */
function baseCase(id: string): string {
  return id.replace(
    /-(?:after-an-installation#1|with-other-(?:identity|workspace))$/,
    '',
  );
}

function requiredKeys(definition: string): string[] {
  return [...schema.$defs[definition].required].sort();
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

describe('Managed context envelope contract', () => {
  it('validates the shared fixtures against the shared schema', () => {
    expect(validateSuite(fixtures)).toBe(true);
    expect(validateSuite.errors).toBeNull();
  });

  it('closes every record definition of the schema', () => {
    const actual = CLOSED_DEFINITIONS.map((name) => ({
      name,
      keywords: sortedKeys(schema.$defs[name]),
      additionalProperties: schema.$defs[name].additionalProperties,
      properties: sortedKeys(schema.$defs[name].properties),
    }));
    const expected = CLOSED_DEFINITIONS.map((name) => ({
      name,
      keywords: CLOSED_KEYWORDS,
      additionalProperties: false,
      properties: requiredKeys(name),
    }));

    expect(actual).toStrictEqual(expected);
  });

  it('agrees with the schema except where the schema cannot state a rule', () => {
    const disagreements = {
      boot: new Set<string>(),
      ready: new Set<string>(),
      attestation: new Set<string>(),
      installation: new Set<string>(),
    };
    // Every disagreement must be a case the contract refuses and the schema
    // accepts; the reverse would put the schema in the wrong.
    const acceptedButSchemaInvalid: string[] = [];
    const compare = (
      list: keyof typeof disagreements,
      id: string,
      schemaValid: boolean,
      contractValid: boolean,
    ) => {
      if (schemaValid !== contractValid) {
        disagreements[list].add(baseCase(id));
        if (contractValid) {
          acceptedButSchemaInvalid.push(`${list} ${id}`);
        }
      }
    };
    for (const fixture of fixtures.bootCases) {
      compare(
        'boot',
        fixture.id,
        schemaAccepts('bootV2', fixture.boot),
        fixture.valid,
      );
    }
    for (const fixture of fixtures.readyCases) {
      compare(
        'ready',
        fixture.id,
        schemaAccepts('readyV2', fixture.ready),
        fixture.valid,
      );
    }
    for (const fixture of fixtures.attestationCases) {
      compare(
        'attestation',
        fixture.id,
        schemaAccepts('attestationRequestV3', fixture.body),
        fixture.expected.status !== 400,
      );
    }
    for (const sequence of fixtures.installationSequences) {
      sequence.steps.forEach((step, index) => {
        compare(
          'installation',
          sequence.steps.length > 1 ? `${sequence.id}#${index}` : sequence.id,
          schemaAccepts('installationRequest', step.request),
          step.expected.status !== 400,
        );
      });
    }

    expect(acceptedButSchemaInvalid).toEqual([]);
    expect({
      boot: [...disagreements.boot].sort(),
      ready: [...disagreements.ready].sort(),
      attestation: [...disagreements.attestation].sort(),
      installation: [...disagreements.installation].sort(),
    }).toEqual(BEYOND_SCHEMA);
  });

  it('pins the protocol token, versions and routes', () => {
    expect(fixtures.contractVersion).toBe(1);
    expect(fixtures.managedContext).toBe(MANAGED_CONTEXT_PROTOCOL);
    expect(fixtures.bootVersion).toBe(MANAGED_CONTEXT_BOOT_VERSION);
    expect(fixtures.readyVersion).toBe(MANAGED_CONTEXT_READY_VERSION);
    expect(fixtures.routes).toStrictEqual(MANAGED_CONTEXT_ROUTES);
  });

  it('uses each case id once in each list', () => {
    for (const list of [
      fixtures.bootCases,
      fixtures.readyCases,
      fixtures.attestationCases,
      fixtures.installationSequences,
    ]) {
      const ids = list.map((fixture) => fixture.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it.each(fixtures.bootCases)('parses the $id boot case', (fixture) => {
    if (fixture.valid) {
      expect(parseManagedContextBoot(fixture.boot)).toStrictEqual(fixture.boot);
    } else {
      expect(() => parseManagedContextBoot(fixture.boot)).toThrow(
        INVALID_BOOT_MESSAGE,
      );
    }
  });

  it('builds the shared ready record', () => {
    const ready = createManagedContextReady(boot, readyPort);

    expect(ready).toStrictEqual(fixtures.ready);
    expect(Object.isFrozen(ready)).toBe(true);
  });

  it.each([1, 65535])(
    'builds and accepts a ready record for port %s',
    (port) => {
      const ready = createManagedContextReady(boot, port);

      expect(ready.url).toBe(`http://127.0.0.1:${port}`);
      expect(isManagedContextReady(ready, boot)).toBe(true);
    },
  );

  it.each(fixtures.readyCases)('checks the $id ready case', (fixture) => {
    expect(isManagedContextReady(fixture.ready, boot)).toBe(fixture.valid);
  });

  it('builds the shared attestation response', () => {
    const response = createManagedContextAttestationResponse(boot);
    const outcome = checkManagedContextAttestation(
      fixtures.attestationCases[0].body,
      boot,
    );

    expect(response).toStrictEqual(fixtures.attestationResponse);
    expect(Object.isFrozen(response)).toBe(true);
    expect(outcome.status).toBe(200);
    expect(Object.isFrozen((outcome as { body: object }).body)).toBe(true);
  });

  it.each(fixtures.attestationCases)(
    'answers the $id attestation case',
    (fixture) => {
      expect(checkManagedContextAttestation(fixture.body, boot)).toStrictEqual(
        fixture.expected,
      );
    },
  );

  it.each(fixtures.installationSequences)(
    'replays the $id installation sequence',
    (sequence) => {
      const installations = new ManagedContextInstallations(boot);
      for (const step of sequence.steps) {
        expect(installations.install(step.request)).toStrictEqual(
          step.expected,
        );
      }
    },
  );

  it('builds records with exactly the schema keys', () => {
    const installations = new ManagedContextInstallations(boot);
    const outcome = installations.install(installationRequest);

    expect(sortedKeys(createManagedContextReady(boot, readyPort))).toEqual(
      requiredKeys('readyV2'),
    );
    expect(sortedKeys(createManagedContextAttestationResponse(boot))).toEqual(
      requiredKeys('attestationResponseV3'),
    );
    expect(outcome.status).toBe(200);
    expect(sortedKeys((outcome as { body: object }).body)).toEqual(
      requiredKeys('receipt'),
    );
    expect(sortedKeys(parseManagedContextBoot(boot))).toEqual(
      requiredKeys('bootV2'),
    );
  });

  it('computes each accepted contextDigest with the W0a digest', () => {
    for (const sequence of fixtures.installationSequences) {
      for (const step of sequence.steps) {
        if (step.expected.status === 200) {
          const request = step.request as {
            readonly binding: Parameters<typeof computeManagedContextDigest>[0];
          };

          expect(step.expected.body.contextDigest).toBe(
            computeManagedContextDigest(request.binding),
          );
        }
      }
    }
  });

  it('gives each binding that breaks a rule the digest of its raw fields', () => {
    // A digest mismatch alone would then refuse the request, and a worker
    // that enforced no binding rule would still pass the fixtures.
    const mismatches: string[] = [];
    let checked = 0;
    for (const sequence of fixtures.installationSequences) {
      for (const step of sequence.steps) {
        const request = step.request as {
          readonly binding?: unknown;
          readonly contextDigest?: unknown;
        } | null;
        const binding = request?.binding;
        if (typeof binding !== 'object' || binding === null) {
          continue;
        }
        let valid = true;
        try {
          computeManagedContextDigest(binding as ManagedContextBinding);
        } catch {
          valid = false;
        }
        const raw = rawDigest(binding as Record<string, unknown>);
        if (valid || raw === undefined) {
          continue;
        }
        checked++;
        if (request?.contextDigest !== raw) {
          mismatches.push(sequence.id);
        }
      }
    }

    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it('returns the original receipt when an installation repeats', () => {
    const installations = new ManagedContextInstallations(boot);
    const first = installations.install(installationRequest);
    const second = installations.install(structuredClone(installationRequest));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second as { body: unknown }).body).toBe(
      (first as { body: unknown }).body,
    );
    expect(Object.isFrozen((first as { body: unknown }).body)).toBe(true);
  });

  it('keeps each Runtime its own installations', () => {
    const first = new ManagedContextInstallations(boot);
    const second = new ManagedContextInstallations(boot);
    const otherSession = { ...installationRequest, sessionId: 'session-2' };

    expect(first.install(installationRequest).status).toBe(200);
    expect(second.install(otherSession).status).toBe(200);
  });

  it('returns a frozen copy of the boot document', () => {
    const input = structuredClone(boot) as unknown as Record<string, unknown>;
    const parsed = parseManagedContextBoot(input);
    input['mountRoot'] = '/elsewhere';

    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.mountRoot).toBe(boot.mountRoot);
  });

  it('reads each boot field once, so the checked value is kept', () => {
    for (const field of requiredKeys('bootV2')) {
      const changing = withChangingField(
        boot as unknown as Record<string, unknown>,
        field,
        (boot as unknown as Record<string, unknown>)[field],
        field === 'epoch' ? 0 : '',
      );

      expect(parseManagedContextBoot(changing.value)).toStrictEqual(boot);
      expect(changing.reads()).toBe(1);
    }
  });

  it('reads each installation field once, so the checked value is used', () => {
    for (const field of requiredKeys('installationRequest')) {
      if (field === 'binding') continue;
      const changing = withChangingField(
        installationRequest,
        field,
        installationRequest[field],
        field === 'protocolVersion' ? 2 : 'other/value',
      );

      expect(
        new ManagedContextInstallations(boot).install(changing.value),
      ).toStrictEqual(firstInstallation.expected);
      expect(changing.reads()).toBe(1);
    }
    for (const field of requiredKeys('binding')) {
      const changing = withChangingField(
        installationRequest.binding,
        field,
        installationRequest.binding[field],
        '../escape',
      );
      const request = { ...installationRequest, binding: changing.value };

      expect(
        new ManagedContextInstallations(boot).install(request),
      ).toStrictEqual(firstInstallation.expected);
      expect(changing.reads()).toBe(1);
    }
  });

  it('refuses a function that carries every key', () => {
    // Object.keys lists exactly the fixture keys on these functions.
    const callable = <T extends object>(value: T) =>
      Object.assign(() => undefined, value);

    expect(() => parseManagedContextBoot(callable(boot))).toThrow(
      INVALID_BOOT_MESSAGE,
    );
    expect(isManagedContextReady(callable(fixtures.ready), boot)).toBe(false);
    expect(
      checkManagedContextAttestation(
        callable(fixtures.attestationCases[0].body as object),
        boot,
      ),
    ).toStrictEqual({
      status: 400,
      code: 'managed_runtime_attestation_invalid',
    });
    expect(
      new ManagedContextInstallations(boot).install(
        callable(installationRequest),
      ),
    ).toStrictEqual({
      status: 400,
      code: 'managed_runtime_attestation_invalid',
    });
    expect(
      new ManagedContextInstallations(boot).install({
        ...installationRequest,
        binding: callable(installationRequest.binding),
      }),
    ).toStrictEqual({
      status: 400,
      code: 'managed_runtime_attestation_invalid',
    });
  });

  it.each([0, 65536, 1.5, -1, Number.NaN])(
    'refuses to build a ready record for port %s',
    (port) => {
      expect(() => createManagedContextReady(boot, port)).toThrow(
        'Managed context ready port is invalid.',
      );
    },
  );

  it('validates the boot document wherever one is passed', () => {
    const invalid = { ...boot, version: 1 } as unknown as ManagedContextBoot;

    expect(() => createManagedContextReady(invalid, readyPort)).toThrow(
      INVALID_BOOT_MESSAGE,
    );
    expect(() => isManagedContextReady(fixtures.ready, invalid)).toThrow(
      INVALID_BOOT_MESSAGE,
    );
    expect(() => createManagedContextAttestationResponse(invalid)).toThrow(
      INVALID_BOOT_MESSAGE,
    );
    expect(() =>
      checkManagedContextAttestation(fixtures.attestationResponse, invalid),
    ).toThrow(INVALID_BOOT_MESSAGE);
    expect(() => new ManagedContextInstallations(invalid)).toThrow(
      INVALID_BOOT_MESSAGE,
    );
  });

  it('never echoes the bearer token', () => {
    const token = 'secret-token-value';
    const secretBoot = { ...boot, token };
    let message = '';
    try {
      parseManagedContextBoot({ ...secretBoot, epoch: 0 });
    } catch (error) {
      message = (error as Error).message;
    }
    const installations = new ManagedContextInstallations(secretBoot);
    const installed = installations.install(installationRequest);
    const outputs = [
      createManagedContextReady(secretBoot, readyPort),
      createManagedContextAttestationResponse(secretBoot),
      checkManagedContextAttestation(
        fixtures.attestationCases[0].body,
        secretBoot,
      ),
      checkManagedContextAttestation({}, secretBoot),
      installed,
      installations.install(installationRequest),
      installations.install({ ...installationRequest, operationId: 'op/1' }),
    ];

    expect(message).toBe(INVALID_BOOT_MESSAGE);
    expect(installed.status).toBe(200);
    expect(JSON.stringify(outputs)).not.toContain(token);
  });

  it('keeps the largest records within their body limits', () => {
    // Backslashes and quotes double when JSON-encoded; C0 controls and lone
    // surrogates take six bytes. These values are the largest each rule
    // allows.
    const largest = parseManagedContextBoot({
      ...boot,
      runtimeInstanceId: 'i'.repeat(128),
      runtimeIncarnation: 'n'.repeat(128),
      leaseId: 'l'.repeat(128),
      provisionRequestId: 'p'.repeat(128),
      epoch: Number.MAX_SAFE_INTEGER,
      tenantId: 't'.repeat(128),
      workspaceId: 'w'.repeat(128),
      workspaceGeneration: '9223372036854775807',
      storageId: '"'.repeat(256),
      mountRoot: '\\'.repeat(4096),
    });
    const binding = {
      tenantId: largest.tenantId,
      workspaceId: largest.workspaceId,
      workspaceGeneration: largest.workspaceGeneration,
      storageId: largest.storageId,
      cwdRelative: '\u{1D11E}'.repeat(1024),
      contextConfigRef: '"'.repeat(512),
      contextRevision: '9223372036854775807',
    };
    const request = {
      protocolVersion: 3,
      managedContext: MANAGED_CONTEXT_PROTOCOL,
      operationId: 'o'.repeat(128),
      sessionId: '\u0001'.repeat(512),
      binding,
      contextDigest: computeManagedContextDigest(binding),
    };
    const attestation = {
      protocolVersion: 3,
      managedContext: MANAGED_CONTEXT_PROTOCOL,
      provisionRequestId: largest.provisionRequestId,
      tenantId: largest.tenantId,
      workspaceId: largest.workspaceId,
      workspaceGeneration: largest.workspaceGeneration,
      storageId: largest.storageId,
      mountRoot: largest.mountRoot,
      capabilityDigest: largest.capabilityDigest,
      isolationClass: largest.isolationClass,
    };
    const installed = new ManagedContextInstallations(largest).install(request);
    const answered = checkManagedContextAttestation(attestation, largest);
    const bytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8');

    expect(installed.status).toBe(200);
    expect(answered.status).toBe(200);
    for (const record of [
      request,
      (installed as { body: object }).body,
      attestation,
      (answered as { body: object }).body,
    ]) {
      expect(bytes(record)).toBeLessThanOrEqual(
        MANAGED_CONTEXT_ROUTES[0].requestBodyLimitBytes,
      );
    }
    expect(
      MANAGED_CONTEXT_ROUTES.map((route) => route.requestBodyLimitBytes),
    ).toEqual([16384, 16384]);
  });

  it('lists every refusal of the fixtures in the error table', () => {
    const table = new Set(
      fixtures.errors.map((error) => `${error.status} ${error.code}`),
    );
    const refusals = [
      ...fixtures.attestationCases.map((fixture) => fixture.expected),
      ...fixtures.installationSequences.flatMap((sequence) =>
        sequence.steps.map((step) => step.expected),
      ),
    ].filter((outcome) => outcome.status !== 200) as Array<{
      status: number;
      code: string;
    }>;

    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      expect(table.has(`${refusal.status} ${refusal.code}`)).toBe(true);
    }
    expect(INVALID).toStrictEqual(
      fixtures.attestationCases.find((f) => f.id === 'array-body')?.expected,
    );
  });
});
