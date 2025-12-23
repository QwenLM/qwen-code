/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
export function getTotalSteps(generationMethod: 'qwen' | 'manual'): number {
  return generationMethod === 'manual' ? 7 : 5;
}

/**
 * Sanitizes user input by removing dangerous characters and normalizing whitespace.
 */
export function sanitizeInput(input: string): string {
  return (
    input
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .replace(/\s+/g, ' ') // Normalize whitespace
  );
}

export type StepKind =
  | 'LOCATION'
  | 'GEN_METHOD'
  | 'LLM_DESC'
  | 'MANUAL_NAME'
  | 'MANUAL_DESC'
  | 'INSTRUCTIONS_INPUT'
  | 'COLOR'
  | 'FINAL'
  | 'UNKNOWN';

export function validateSkillName(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'skills.create.error.nameEmpty';
  }
  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    return 'skills.create.error.nameFormat';
  }
  if (trimmed.length > 64) {
    return 'skills.create.error.nameLength';
  }
  if (['anthropic', 'claude', 'qwen'].some((word) => trimmed.includes(word))) {
    return 'skills.create.error.nameReserved';
  }
  return null;
}

export function validateSkillDescription(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'skills.create.error.descriptionEmpty';
  }
  if (trimmed.length > 1024) {
    return 'skills.create.error.descriptionLength';
  }
  if (/<[^>]+>/.test(trimmed)) {
    return 'skills.create.error.descriptionXml';
  }
  return null;
}

export function getStepKind(
  generationMethod: 'qwen' | 'manual',
  step: number,
): StepKind {
  if (generationMethod === 'manual') {
    // Map manual steps
    switch (step) {
      case 1:
        return 'LOCATION';
      case 2:
        return 'GEN_METHOD';
      case 3:
        return 'MANUAL_NAME';
      case 4:
        return 'MANUAL_DESC';
      case 5:
        return 'INSTRUCTIONS_INPUT';
      case 6:
        return 'COLOR';
      case 7:
        return 'FINAL';
      default:
        return 'FINAL';
    }
  }

  // Qwen flow
  switch (step) {
    case 1:
      return 'LOCATION';
    case 2:
      return 'GEN_METHOD';
    case 3:
      return 'LLM_DESC';
    case 4:
      return 'COLOR';
    case 5:
      return 'FINAL';
    default:
      return 'FINAL';
  }
}
