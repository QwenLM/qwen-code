/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PromptAssemblyContext,
  PromptSectionDescriptor,
} from '../types.js';
import { BEHAVIOR_SECTIONS } from './behavior.js';
import {
  COMMUNICATION_VARIANT_DESCRIPTORS,
  PRONOUNS_DESCRIPTOR,
  selectCommunicationVariant,
} from './communication.js';
import { CORE_FULL_SECTIONS } from './core-full.js';
import { CORE_LEAN_SECTIONS } from './core-lean.js';
import { MANDATORY_SECTIONS } from './mandatory.js';
import { PREFERENCE_SECTIONS } from './preferences.js';
import { SECURITY_SECTIONS } from './security.js';

/**
 * 静态部分只在模块加载时拼一次；只有 communication 需要按 context 选变体。
 */
const SECTIONS_BEFORE_COMMUNICATION: readonly PromptSectionDescriptor[] =
  Object.freeze([
    ...MANDATORY_SECTIONS,
    ...SECURITY_SECTIONS,
    ...CORE_FULL_SECTIONS,
    ...CORE_LEAN_SECTIONS,
  ]);

const SECTIONS_AFTER_COMMUNICATION: readonly PromptSectionDescriptor[] =
  Object.freeze([
    PRONOUNS_DESCRIPTOR,
    ...BEHAVIOR_SECTIONS,
    ...PREFERENCE_SECTIONS,
  ]);

/**
 * 每个 descriptor 各出现一次（communication 的四个变体全在内），供模块加载时
 * 一次性校验。descriptor 的约束都是编译期常量，没必要每个 turn 重跑校验。
 */
export const ALL_PROMPT_SECTION_DESCRIPTORS: readonly PromptSectionDescriptor[] =
  Object.freeze([
    ...SECTIONS_BEFORE_COMMUNICATION,
    ...COMMUNICATION_VARIANT_DESCRIPTORS,
    ...SECTIONS_AFTER_COMMUNICATION,
  ]);

export function definePromptSectionDescriptors(
  context: PromptAssemblyContext,
): readonly PromptSectionDescriptor[] {
  return [
    ...SECTIONS_BEFORE_COMMUNICATION,
    selectCommunicationVariant(context),
    ...SECTIONS_AFTER_COMMUNICATION,
  ];
}
