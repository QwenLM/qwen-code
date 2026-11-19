/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedInvocationObservation } from '@qwen-code/qwen-code-core/managed-runtime/managed-execution-diagnostics.js';
import type { HostedSkillCatalog } from './hosted-skill-catalog.js';

export function hostedSkillDiagnostic(
  catalog: HostedSkillCatalog,
  args: Record<string, unknown>,
  origin: 'user' | 'model' | 'unknown',
  revision?: number,
): ManagedInvocationObservation['skill'] {
  const name = String(args['skill']);
  const command = catalog.command(args);
  const resource =
    command ?? catalog.entries().find((skill) => skill.name === name);
  return resource
    ? {
        resourceKind: command ? 'extension_command' : 'skill',
        name,
        pin: createHash('sha256')
          .update(JSON.stringify([revision ?? null, resource]))
          .digest('hex'),
        origin,
        delivery: 'unknown',
      }
    : null;
}
