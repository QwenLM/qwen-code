/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repairBunNativesRuntime,
  runLogger,
} from '@qwen-code/core';

export type ModifierName = 'shift' | 'ctrl' | 'alt' | 'cmd';

export interface ModifierState {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  cmd: boolean;
}

interface NativeModifierBinding {
  isModifierPressed(modifier: ModifierName): boolean;
  getModifiers(): ModifierState;
  prewarm(): void;
}

const requireFromHere = createRequire(import.meta.url);
let nativeBinding: NativeModifierBinding | null | undefined;

function nativeRelativePath(): string {
  return path.join(
    'prebuilds',
    `darwin-${process.arch}`,
    'modifiers.node',
  );
}

function nativeBindingCandidates(): string[] {
  const relativePath = nativeRelativePath();
  const candidates: string[] = [];
  const extractedRuntime = repairBunNativesRuntime();
  if (extractedRuntime) {
    candidates.push(
      path.join(
        extractedRuntime,
        'node_modules/@qwen-code/native-modifiers',
        relativePath,
      ),
    );
  }

  // Source runs resolve under packages/cli/src/native-modifiers. The package
  // build copies the same tree under dist/src/native-modifiers, so this path
  // also works for the published Node.js CLI.
  candidates.push(
    fileURLToPath(
      new URL(`../../native-modifiers/${relativePath}`, import.meta.url),
    ),
  );
  return candidates;
}

function isNativeModifierBinding(
  candidate: unknown,
): candidate is NativeModifierBinding {
  if (!candidate || typeof candidate !== 'object') return false;
  const binding = candidate as Partial<NativeModifierBinding>;
  return (
    typeof binding.isModifierPressed === 'function' &&
    typeof binding.getModifiers === 'function' &&
    typeof binding.prewarm === 'function'
  );
}

function getNativeBinding(): NativeModifierBinding | null {
  if (nativeBinding !== undefined) return nativeBinding;
  if (process.platform !== 'darwin') {
    nativeBinding = null;
    return nativeBinding;
  }

  let lastError: unknown;
  for (const candidatePath of nativeBindingCandidates()) {
    try {
      const candidate = requireFromHere(candidatePath) as unknown;
      if (!isNativeModifierBinding(candidate)) {
        throw new Error('Native modifier binding has an invalid interface');
      }
      nativeBinding = candidate;
      return nativeBinding;
    } catch (error) {
      lastError = error;
    }
  }

  nativeBinding = null;
  runLogger.debug(
    'Native macOS modifier detection is unavailable; Shift+Enter detection in Terminal.app is disabled.',
    lastError,
  );
  return nativeBinding;
}

function disableBindingAfterError(action: string, error: unknown): void {
  nativeBinding = null;
  runLogger.debug(
    `Native macOS modifier detection failed during ${action}; disabling it for this process.`,
    error,
  );
}

/** Loads the native binding and performs one modifier-state query. */
export function prewarmNativeModifierDetector(): boolean {
  const binding = getNativeBinding();
  if (!binding) return false;
  try {
    binding.prewarm();
    return true;
  } catch (error) {
    disableBindingAfterError('prewarm', error);
    return false;
  }
}

export function isNativeModifierDetectionAvailable(): boolean {
  return getNativeBinding() !== null;
}

export function isModifierPressed(modifier: ModifierName): boolean {
  const binding = getNativeBinding();
  if (!binding) return false;
  try {
    return binding.isModifierPressed(modifier);
  } catch (error) {
    disableBindingAfterError('modifier query', error);
    return false;
  }
}

export function getPressedModifiers(): ModifierState | null {
  const binding = getNativeBinding();
  if (!binding) return null;
  try {
    return binding.getModifiers();
  } catch (error) {
    disableBindingAfterError('modifier query', error);
    return null;
  }
}
