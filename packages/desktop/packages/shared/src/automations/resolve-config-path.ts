/**
 * Automations Config Path Resolver
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';

/**
 * Generate a short 6-character hex ID for matcher identification.
 * Uses crypto.randomBytes for uniqueness (24 bits of entropy = 16M possibilities).
 */
export function generateShortId(): string {
  return randomBytes(3).toString('hex');
}

/**
 * Resolve the automations config path for a workspace.
 */
export function resolveAutomationsConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, AUTOMATIONS_CONFIG_FILE);
}
