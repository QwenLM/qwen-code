/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interface for OAuth tokens.
 */
export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

/**
 * Interface for stored OAuth credentials.
 */
export interface OAuthCredentials {
  serverName: string;
  token: OAuthToken;
  clientId?: string;
  tokenUrl?: string;
  mcpServerUrl?: string;
  updatedAt: number;
}

export interface TokenStorage {
  getCredentials(serverName: string): Promise<OAuthCredentials | null>;
  setCredentials(credentials: OAuthCredentials): Promise<void>;
  deleteCredentials(serverName: string): Promise<void>;
  listServers(): Promise<string[]>;
  getAllCredentials(): Promise<Map<string, OAuthCredentials>>;
  clearAll(): Promise<void>;
}

/**
 * Storage for arbitrary named secrets (e.g. sensitive extension settings),
 * scoped to the backing store's service name. Implemented by both the keychain
 * and the encrypted-file backends so that secrets degrade gracefully to file
 * storage when the OS keychain is unavailable.
 */
export interface SecretStorage {
  isAvailable(): Promise<boolean>;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  listSecrets(): Promise<string[]>;
}

export enum TokenStorageType {
  KEYCHAIN = 'keychain',
  ENCRYPTED_FILE = 'encrypted_file',
}
