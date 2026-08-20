/**
 * Environment Variable Backend (DISABLED)
 *
 * This backend is currently disabled to force manual API key entry.
 * Kept as a placeholder for potential future use.
 */

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

export class EnvironmentBackend implements CredentialBackend {
  readonly name = 'environment';
  readonly priority = 110; // Higher than file (100) so env vars override file storage

  async isAvailable(): Promise<boolean> {
    // Disabled by user request to force manual API keys
    return false;
  }

  async get(_id: CredentialId): Promise<StoredCredential | null> {
    return null;
  }

  async set(_id: CredentialId, _credential: StoredCredential): Promise<void> {
    throw new Error('Environment backend is disabled');
  }

  async delete(_id: CredentialId): Promise<boolean> {
    return false;
  }

  async list(_filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    return [];
  }
}
