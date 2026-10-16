/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { FunctionDeclaration } from '@google/genai';
import { validateSkillName } from '@qwen-code/qwen-code-core/skills/types.js';
import { renderAvailableSkillsBlock } from '@qwen-code/qwen-code-core/tools/skill-utils.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';

export const HOSTED_SKILL_CATALOG_MAX_BYTES = 48 * 1024;
export const HOSTED_SKILL_APPROVAL_REFUSAL =
  'Hosted Skill loading cannot request approval; the PreToolUse Hook must allow or deny this instruction-only call.';
export const HOSTED_SKILL_BATCH_REFUSAL =
  'Load Skills in a separate tool batch before calling Workspace tools.';

export interface HostedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly base_directory?: string;
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
    value.length > 16 ||
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
            !['name', 'description', 'body', 'base_directory'].includes(key),
        ) ||
        !boundedText(skill['name'], 128) ||
        !boundedText(skill['description'], 4096) ||
        !boundedText(skill['body'], 32 * 1024)
      )
        invalid();
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
    if (!this.skills.length) return undefined;
    return `The following published skills are available. Use the skill tool to load their instructions when relevant.\n${renderAvailableSkillsBlock([...this.skills])}`;
  }

  declaration(): FunctionDeclaration | undefined {
    if (!this.skills.length) return undefined;
    return {
      name: 'skill',
      description:
        'Load the instructions of a published skill in a separate batch before calling other tools. Loading does not run scripts or change tool permissions.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: this.skills.map((skill) => skill.name),
          },
        },
        required: ['skill'],
        additionalProperties: false,
      },
    };
  }

  validationError(args: unknown): string | undefined {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return 'Hosted Skill requires only a skill name.';
    const values = args as Record<string, unknown>;
    if (Object.keys(values).length !== 1 || typeof values['skill'] !== 'string')
      return 'Hosted Skill requires only a skill name; arguments and activation options are unsupported.';
    if (!this.skills.some((skill) => skill.name === values['skill']))
      return `Skill ${JSON.stringify(values['skill'])} is not published for this Session.`;
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
