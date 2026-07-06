/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

function isCiEnvKey(key: string): boolean {
  return (
    key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_')
  );
}

export function clearCiEnv(): () => void {
  const saved = new Map<string, string | undefined>();

  for (const key of Object.keys(process.env)) {
    if (isCiEnvKey(key)) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  return () => {
    for (const key of Object.keys(process.env)) {
      if (isCiEnvKey(key) && !saved.has(key)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
