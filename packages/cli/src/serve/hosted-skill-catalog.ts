/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { FunctionDeclaration } from '@google/genai';
import { validateSkillName } from '@qwen-code/qwen-code-core/skills/types.js';
import { renderAvailableSkillsBlock } from '@qwen-code/qwen-code-core/tools/skill-utils.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export const HOSTED_SKILL_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export const HOSTED_SKILL_APPROVAL_REFUSAL =
  'Hosted Skill loading cannot request approval; the PreToolUse Hook must allow or deny this instruction-only call.';
export const HOSTED_SKILL_BATCH_REFUSAL =
  'Load Skills in a separate tool batch before calling Workspace tools.';

export interface HostedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly base_directory?: string;
  readonly model_invocable?: boolean;
  readonly user_invocable?: boolean;
}

export function parseSessionSkillsRef(
  value: unknown,
): ManagedSessionDurableRef | undefined {
  if (value === undefined) return undefined;
  const ref = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'Session Skills',
  );
  if (
    ref.kind !== 'managed-agent-skills' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > HOSTED_SKILL_CATALOG_MAX_BYTES
  )
    throw new Error('Invalid Session Skills reference.');
  return ref;
}

export function sameSessionSkillsRef(
  a: ManagedSessionDurableRef | undefined,
  b: ManagedSessionDurableRef | undefined,
): boolean {
  return (
    a?.resourceId === b?.resourceId &&
    a?.kind === b?.kind &&
    a?.schemaVersion === b?.schemaVersion &&
    a?.byteLength === b?.byteLength &&
    a?.digest === b?.digest
  );
}

function invalid(): never {
  throw new Error('Invalid Hosted skill catalog.');
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/[\ud800-\udfff]/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

export function parseHostedSkills(value: unknown): readonly HostedSkill[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
      HOSTED_SKILL_CATALOG_MAX_BYTES
  )
    invalid();
  const names = new Set<string>();
  return Object.freeze(
    value.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
      const skill = item as Record<string, unknown>;
      if (
        Object.keys(skill).some(
          (key) =>
            ![
              'name',
              'description',
              'body',
              'base_directory',
              'model_invocable',
              'user_invocable',
            ].includes(key),
        ) ||
        !boundedText(skill['name'], 128) ||
        !boundedText(skill['description'], 4096) ||
        !boundedText(skill['body'], 512 * 1024)
      )
        invalid();
      for (const field of ['model_invocable', 'user_invocable']) {
        if (skill[field] !== undefined && typeof skill[field] !== 'boolean')
          invalid();
      }
      validateSkillName(skill['name']);
      if (names.has(skill['name'])) invalid();
      names.add(skill['name']);
      const base = skill['base_directory'];
      if (base !== undefined) {
        if (
          !boundedText(base, 4096) ||
          /[\\:]/u.test(base) ||
          [...base].some((character) => {
            const code = character.codePointAt(0)!;
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
          }) ||
          (base !== '.' &&
            base
              .split('/')
              .some(
                (segment) => !segment || segment === '.' || segment === '..',
              ))
        )
          invalid();
      }
      return Object.freeze({
        name: skill['name'],
        description: skill['description'],
        body: skill['body'],
        ...(base === undefined ? {} : { base_directory: base as string }),
        ...(skill['model_invocable'] === undefined
          ? {}
          : { model_invocable: skill['model_invocable'] as boolean }),
        ...(skill['user_invocable'] === undefined
          ? {}
          : { user_invocable: skill['user_invocable'] as boolean }),
      });
    }),
  );
}

export async function readHostedSkills(
  ref: ManagedSessionDurableRef | undefined,
  resources: Pick<ManagedSessionResourceStore, 'read'>,
): Promise<readonly HostedSkill[]> {
  if (!ref) return [];
  if (
    ref.kind !== 'managed-agent-skills' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > HOSTED_SKILL_CATALOG_MAX_BYTES
  )
    throw new Error('Invalid agent skills reference.');
  const bytes = await resources.read(ref);
  if (
    bytes.byteLength !== ref.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== ref.digest
  )
    throw new Error('Agent skills do not match their reference.');
  return parseHostedSkills(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
}

export class HostedSkillCatalog {
  private readonly skills: readonly HostedSkill[];

  constructor(skills: readonly HostedSkill[]) {
    this.skills = parseHostedSkills(skills);
  }

  instructions(): string | undefined {
    const available = this.skills.filter(
      (skill) => skill.model_invocable !== false,
    );
    if (!available.length) return undefined;
    return `The following published skills are available. Use the skill tool to load their instructions when relevant.\n${renderAvailableSkillsBlock(available)}`;
  }

  invocations(prompt: string): string[] {
    const names = new Set<string>();
    let remaining = prompt;
    for (;;) {
      const match = /^\s*\/([^\s/]+)(?=\s|$)/u.exec(remaining);
      if (
        !match ||
        !this.skills.some(
          (skill) => skill.name === match[1] && skill.user_invocable !== false,
        )
      )
        return [...names];
      names.add(match[1]);
      remaining = remaining.slice(match[0].length);
    }
  }

  declaration(): FunctionDeclaration | undefined {
    const available = this.skills.filter(
      (skill) => skill.model_invocable !== false,
    );
    if (!available.length) return undefined;
    return {
      name: 'skill',
      description:
        'Load the instructions of a published skill in a separate batch before calling other tools. Loading does not run scripts or change tool permissions.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: available.map((skill) => skill.name),
          },
        },
        required: ['skill'],
        additionalProperties: false,
      },
    };
  }

  validationError(
    args: unknown,
    origin?: 'user' | 'model',
  ): string | undefined {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return 'Hosted Skill requires only a skill name.';
    const values = args as Record<string, unknown>;
    if (Object.keys(values).length !== 1 || typeof values['skill'] !== 'string')
      return 'Hosted Skill requires only a skill name; arguments and activation options are unsupported.';
    if (!this.skills.some((skill) => skill.name === values['skill']))
      return `Skill ${JSON.stringify(values['skill'])} is not published for this Session.`;
    const skill = this.skills.find((entry) => entry.name === values['skill'])!;
    if (origin === 'model' && skill.model_invocable === false)
      return 'This Skill may only be invoked by the user.';
    if (origin === 'user' && skill.user_invocable === false)
      return 'This Skill is not user-invocable.';
    return undefined;
  }

  response(args: unknown): string {
    const error = this.validationError(args);
    if (error) throw new Error(error);
    const name = (args as { skill: string }).skill;
    const skill = this.skills.find((entry) => entry.name === name)!;
    return `Base directory for this skill relative to the Session working directory: ${skill.base_directory ?? '.'}\nResolve asset paths relative to this directory with the Workspace tools.\n\n${skill.body}\n`;
  }
}
