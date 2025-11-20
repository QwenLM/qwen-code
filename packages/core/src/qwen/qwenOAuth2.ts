/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'os';

import open from 'open';
import { EventEmitter } from 'events';
import type { Config } from '../config/config.js';
import { randomUUID } from 'node:crypto';
import {
  SharedTokenManager,
  TokenManagerError,
  TokenError,
} from './sharedTokenManager.js';

// OAuth Endpoints
const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai';

const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;

// OAuth Client Configuration
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';

const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';

/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Implements RFC 7636 - Proof Key for Code Exchange by OAuth Public Clients
 */

/**
 * Generate a random code verifier for PKCE
 * @returns A random string of 43-128 characters
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a code challenge from a code verifier using SHA-256
 * @param codeVerifier The code verifier string
 * @returns The code challenge string
 */
export function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(codeVerifier);
  return hash.digest('base64url');
}

/**
 * Generate PKCE code verifier and challenge pair
 * @returns Object containing code_verifier and code_challenge
 */
export function generatePKCEPair(): {
  code_verifier: string;
  code_challenge: string;
} {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

/**
 * Convert object to URL-encoded form data
 * @param data The object to convert
 * @returns URL-encoded string
 */
function objectToUrlEncoded(data: Record<string, string>): string {
  return Object.keys(data)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
    .join('&');
}

/**
 * Standard error response data
 */
export interface ErrorData {
  error: string;
  error_description: string;
}

/**
 * Custom error class to indicate that credentials should be cleared
 * This is thrown when a 400 error occurs during token refresh, indicating
 * that the refresh token is expired or invalid
 */
export class CredentialsClearRequiredError extends Error {
  constructor(
    message: string,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = 'CredentialsClearRequiredError';
  }
}

/**
 * Qwen OAuth2 credentials interface
 */
export interface QwenCredentials {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
  token_type?: string;
  resource_url?: string;
}

/**
 * Device authorization success data
 */
export interface DeviceAuthorizationData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
}

/**
 * Device authorization response interface
 */
export type DeviceAuthorizationResponse = DeviceAuthorizationData | ErrorData;

/**
 * Type guard to check if device authorization was successful
 */
export function isDeviceAuthorizationSuccess(
  response: DeviceAuthorizationResponse,
): response is DeviceAuthorizationData {
  return 'device_code' in response;
}

/**
 * Device token success data
 */
export interface DeviceTokenData {
  access_token: string | null;
  refresh_token?: string | null;
  token_type: string;
  expires_in: number | null;
  scope?: string | null;
  endpoint?: string;
  resource_url?: string;
}

/**
 * Device token pending response
 */
export interface DeviceTokenPendingData {
  status: 'pending';
  slowDown?: boolean; // Indicates if client should increase polling interval
}

/**
 * Device token response interface
 */
export type DeviceTokenResponse =
  | DeviceTokenData
  | DeviceTokenPendingData
  | ErrorData;

/**
 * Type guard to check if device token response was successful
 */
export function isDeviceTokenSuccess(
  response: DeviceTokenResponse,
): response is DeviceTokenData {
  return (
    'access_token' in response &&
    response.access_token !== null &&
    response.access_token !== undefined &&
    typeof response.access_token === 'string' &&
    response.access_token.length > 0
  );
}

/**
 * Type guard to check if device token response is pending
 */
export function isDeviceTokenPending(
  response: DeviceTokenResponse,
): response is DeviceTokenPendingData {
  return (
    'status' in response &&
    (response as DeviceTokenPendingData).status === 'pending'
  );
}

/**
 * Type guard to check if response is an error
 */
export function isErrorResponse(
  response:
    | DeviceAuthorizationResponse
    | DeviceTokenResponse
    | TokenRefreshResponse,
): response is ErrorData {
  return 'error' in response;
}

/**
 * Token refresh success data
 */
export interface TokenRefreshData {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string; // Some OAuth servers may return a new refresh token
  resource_url?: string;
}

/**
 * Token refresh response interface
 */
export type TokenRefreshResponse = TokenRefreshData | ErrorData;

/**
 * Qwen OAuth2 client interface
 */
export interface IQwenOAuth2Client {
  setCredentials(credentials: QwenCredentials): void;
  getCredentials(): QwenCredentials;
  getAccessToken(): Promise<{ token?: string }>;
  requestDeviceAuthorization(options: {
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
  }): Promise<DeviceAuthorizationResponse>;
  pollDeviceToken(options: {
    device_code: string;
    code_verifier: string;
  }): Promise<DeviceTokenResponse>;
  refreshAccessToken(): Promise<TokenRefreshResponse>;
}

/**
 * Qwen OAuth2 client implementation
 */
export class QwenOAuth2Client implements IQwenOAuth2Client {
  private credentials: QwenCredentials = {};
  private sharedManager: SharedTokenManager;

  constructor() {
    this.sharedManager = SharedTokenManager.getInstance();
  }

  setCredentials(credentials: QwenCredentials): void {
    this.credentials = credentials;
  }

  getCredentials(): QwenCredentials {
    return this.credentials;
  }

  async getAccessToken(): Promise<{ token?: string }> {
    try {
      // Always use shared manager for consistency - this prevents race conditions
      // between local credential state and shared state
      const credentials = await this.sharedManager.getValidCredentials(this);
      return { token: credentials.access_token };
    } catch (error) {
      console.warn('Failed to get access token from shared manager:', error);

      // Don't use fallback to local credentials to prevent race conditions
      // All token management should go through SharedTokenManager for consistency
      // This ensures single source of truth and prevents cross-session issues
      return { token: undefined };
    }
  }

  async requestDeviceAuthorization(options: {
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
  }): Promise<DeviceAuthorizationResponse> {
    const bodyData = {
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: options.scope,
      code_challenge: options.code_challenge,
      code_challenge_method: options.code_challenge_method,
    };

    const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'x-request-id': randomUUID(),
      },
      body: objectToUrlEncoded(bodyData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(
        `Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorData}`,
      );
    }

    const result = (await response.json()) as DeviceAuthorizationResponse;
    console.debug('Device authorization result:', result);

    // Check if the response indicates success
    if (!isDeviceAuthorizationSuccess(result)) {
      const errorData = result as ErrorData;
      throw new Error(
        `Device authorization failed: ${errorData?.error || 'Unknown error'} - ${errorData?.error_description || 'No details provided'}`,
      );
    }

    return result;
  }

  async pollDeviceToken(options: {
    device_code: string;
    code_verifier: string;
  }): Promise<DeviceTokenResponse> {
    const bodyData = {
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: options.device_code,
      code_verifier: options.code_verifier,
    };

    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: objectToUrlEncoded(bodyData),
    });

    if (!response.ok) {
      // Read response body as text first (can only be read once)
      const responseText = await response.text();

      // Try to parse as JSON to check for OAuth RFC 8628 standard errors
      let errorData: ErrorData | null = null;
      try {
        errorData = JSON.parse(responseText) as ErrorData;
      } catch (_parseError) {
        // If JSON parsing fails, use text response
        const error = new Error(
          `Device token poll failed: ${response.status} ${response.statusText}. Response: ${responseText}`,
        );
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }

      // According to OAuth RFC 8628, handle standard polling responses
      if (
        response.status === 400 &&
        errorData.error === 'authorization_pending'
      ) {
        // User has not yet approved the authorization request. Continue polling.
        return { status: 'pending' } as DeviceTokenPendingData;
      }

      if (response.status === 429 && errorData.error === 'slow_down') {
        // Client is polling too frequently. Return pending with slowDown flag.
        return {
          status: 'pending',
          slowDown: true,
        } as DeviceTokenPendingData;
      }

      // Handle other 400 errors (access_denied, expired_token, etc.) as real errors

      // For other errors, throw with proper error information
      const error = new Error(
        `Device token poll failed: ${errorData.error || 'Unknown error'} - ${errorData.error_description}`,
      );
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    return (await response.json()) as DeviceTokenResponse;
  }

  async refreshAccessToken(): Promise<TokenRefreshResponse> {
    if (!this.credentials.refresh_token) {
      throw new Error('No refresh token available');
    }

    const bodyData = {
      grant_type: 'refresh_token',
      refresh_token: this.credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    };

    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: objectToUrlEncoded(bodyData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      // Handle 400 errors which might indicate refresh token expiry
      if (response.status === 400) {
        await clearQwenCredentials();
        throw new CredentialsClearRequiredError(
          "Refresh token expired or invalid. Please use '/auth' to re-authenticate.",
          { status: response.status, response: errorData },
        );
      }
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorData}`,
      );
    }

    const responseData = (await response.json()) as TokenRefreshResponse;

    // Check if the response indicates success
    if (isErrorResponse(responseData)) {
      const errorData = responseData as ErrorData;
      throw new Error(
        `Token refresh failed: ${errorData?.error || 'Unknown error'} - ${errorData?.error_description || 'No details provided'}`,
      );
    }

    // Handle successful response
    const tokenData = responseData as TokenRefreshData;
    const tokens: QwenCredentials = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
      // Use new refresh token if provided, otherwise preserve existing one
      refresh_token: tokenData.refresh_token || this.credentials.refresh_token,
      resource_url: tokenData.resource_url, // Include resource_url if provided
      expiry_date: Date.now() + tokenData.expires_in * 1000,
    };

    this.setCredentials(tokens);

    // Note: File caching is now handled by SharedTokenManager
    // to prevent cross-session token invalidation issues

    return responseData;
  }
}

export enum QwenOAuth2Event {
  AuthUri = 'auth-uri',
  AuthProgress = 'auth-progress',
  AuthCancel = 'auth-cancel',
}

/**
 * Authentication result types to distinguish different failure reasons
 */
export type AuthResult =
  | { success: true }
  | {
      success: false;
      reason: 'timeout' | 'cancelled' | 'error' | 'rate_limit';
      message?: string; // Detailed error message for better error reporting
    };

/**
 * Global event emitter instance for QwenOAuth2 authentication events
 */
export const qwenOAuth2Events = new EventEmitter();

export async function getQwenOAuthClient(
  config: Config,
  options?: { requireCachedCredentials?: boolean },
): Promise<QwenOAuth2Client> {
  const client = new QwenOAuth2Client();

  // Use shared token manager to get valid credentials with cross-session synchronization
  const sharedManager = SharedTokenManager.getInstance();

  try {
    // Try to get valid credentials from shared cache first
    const credentials = await sharedManager.getValidCredentials(client);
    client.setCredentials(credentials);
    return client;
  } catch (error: unknown) {
    // Handle specific token manager errors
    if (error instanceof TokenManagerError) {
      switch (error.type) {
        case TokenError.NO_REFRESH_TOKEN:
          console.debug(
            'No refresh token available, proceeding with device flow',
          );
          break;
        case TokenError.REFRESH_FAILED:
          console.debug('Token refresh failed, proceeding with device flow');
          break;
        case TokenError.NETWORK_ERROR:
          console.warn(
            'Network error during token refresh, trying device flow',
          );
          break;
        default:
          console.warn('Token manager error:', (error as Error).message);
      }
    }

    // If shared manager fails, check if we have cached credentials for device flow
    if (await loadCachedQwenCredentials(client)) {
      // We have cached credentials but they might be expired
      // Try device flow instead of forcing refresh
      const result = await authWithQwenDeviceFlow(client, config);
      if (!result.success) {
        // Use detailed error message if available, otherwise use default
        const errorMessage =
          result.message || 'Qwen OAuth authentication failed';
        throw new Error(errorMessage);
      }
      return client;
    }

    if (options?.requireCachedCredentials) {
      throw new Error(
        'No cached Qwen-OAuth credentials found. Please re-authenticate.',
      );
    }

    const result = await authWithQwenDeviceFlow(client, config);
    if (!result.success) {
      // Only emit timeout event if the failure reason is actually timeout
      // Other error types (401, 429, etc.) have already emitted their specific events
      if (result.reason === 'timeout') {
        qwenOAuth2Events.emit(
          QwenOAuth2Event.AuthProgress,
          'timeout',
          'Authentication timed out. Please try again or select a different authentication method.',
        );
      }

      // Use detailed error message if available, otherwise use default based on reason
      const errorMessage =
        result.message ||
        (() => {
          switch (result.reason) {
            case 'timeout':
              return 'Qwen OAuth authentication timed out';
            case 'cancelled':
              return 'Qwen OAuth authentication was cancelled by user';
            case 'rate_limit':
              return 'Too many request for Qwen OAuth authentication, please try again later.';
            case 'error':
            default:
              return 'Qwen OAuth authentication failed';
          }
        })();

      throw new Error(errorMessage);
    }

    return client;
  }
}

async function authWithQwenDeviceFlow(
  client: QwenOAuth2Client,
  config: Config,
): Promise<AuthResult> {
  let isCancelled = false;

  // Set up cancellation listener
  const cancelHandler = () => {
    isCancelled = true;
  };
  qwenOAuth2Events.once(QwenOAuth2Event.AuthCancel, cancelHandler);

  try {
    // Generate PKCE code verifier and challenge
    const { code_verifier, code_challenge } = generatePKCEPair();

    // Request device authorization
    const deviceAuth = await client.requestDeviceAuthorization({
      scope: QWEN_OAUTH_SCOPE,
      code_challenge,
      code_challenge_method: 'S256',
    });

    // Ensure we have a successful authorization response
    if (!isDeviceAuthorizationSuccess(deviceAuth)) {
      const errorData = deviceAuth as ErrorData;
      throw new Error(
        `Device authorization failed: ${errorData?.error || 'Unknown error'} - ${errorData?.error_description || 'No details provided'}`,
      );
    }

    // Emit device authorization event for UI integration immediately
    qwenOAuth2Events.emit(QwenOAuth2Event.AuthUri, deviceAuth);

    const showFallbackMessage = () => {
      console.log('\n=== Qwen OAuth Device Authorization ===');
      console.log(
        'Please visit the following URL in your browser to authorize:',
      );
      console.log(`\n${deviceAuth.verification_uri_complete}\n`);
      console.log('Waiting for authorization to complete...\n');
    };

    // If browser launch is not suppressed, try to open the URL
    if (!config.isBrowserLaunchSuppressed()) {
      try {
        const childProcess = await open(deviceAuth.verification_uri_complete);

        // IMPORTANT: Attach an error handler to the returned child process.
        // Without this, if `open` fails to spawn a process (e.g., `xdg-open` is not found
        // in a minimal Docker container), it will emit an unhandled 'error' event,
        // causing the entire Node.js process to crash.
        if (childProcess) {
          childProcess.on('error', () => {
            console.debug(
              'Failed to open browser. Visit this URL to authorize:',
            );
            showFallbackMessage();
          });
        }
      } catch (_err) {
        showFallbackMessage();
      }
    } else {
      // Browser launch is suppressed, show fallback message
      showFallbackMessage();
    }

    // Emit auth progress event
    qwenOAuth2Events.emit(
      QwenOAuth2Event.AuthProgress,
      'polling',
      'Waiting for authorization...',
    );

    console.debug('Waiting for authorization...\n');

    // Poll for the token
    let pollInterval = 2000; // 2 seconds, can be increased if slow_down is received
    const maxAttempts = Math.ceil(
      deviceAuth.expires_in / (pollInterval / 1000),
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if authentication was cancelled
      if (isCancelled) {
        const message = 'Authentication cancelled by user.';
        console.debug('\n' + message);
        qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, 'error', message);
        return { success: false, reason: 'cancelled', message };
      }

      try {
        console.debug('polling for token...');
        const tokenResponse = await client.pollDeviceToken({
          device_code: deviceAuth.device_code,
          code_verifier,
        });

        // Check if the response is successful and contains token data
        if (isDeviceTokenSuccess(tokenResponse)) {
          const tokenData = tokenResponse as DeviceTokenData;

          // Convert to QwenCredentials format
          const credentials: QwenCredentials = {
            access_token: tokenData.access_token!, // Safe to assert as non-null due to isDeviceTokenSuccess check
            refresh_token: tokenData.refresh_token || undefined,
            token_type: tokenData.token_type,
            resource_url: tokenData.resource_url,
            expiry_date: tokenData.expires_in
              ? Date.now() + tokenData.expires_in * 1000
              : undefined,
          };

          client.setCredentials(credentials);

          // Cache the new tokens
          await cacheQwenCredentials(credentials);

          // Emit auth progress success event
          qwenOAuth2Events.emit(
            QwenOAuth2Event.AuthProgress,
            'success',
            'Authentication successful! Access token obtained.',
          );

          console.debug('Authentication successful! Access token obtained.');
          return { success: true };
        }

        // Check if the response is pending
        if (isDeviceTokenPending(tokenResponse)) {
          const pendingData = tokenResponse as DeviceTokenPendingData;

          // Handle slow_down error by increasing poll interval
          if (pendingData.slowDown) {
            pollInterval = Math.min(pollInterval * 1.5, 10000); // Increase by 50%, max 10 seconds
            console.debug(
              `\nServer requested to slow down, increasing poll interval to ${pollInterval}ms'`,
            );
          } else {
            pollInterval = 2000; // Reset to default interval
          }

          // Emit polling progress event
          qwenOAuth2Events.emit(
            QwenOAuth2Event.AuthProgress,
            'polling',
            `Polling... (attempt ${attempt + 1}/${maxAttempts})`,
          );

          // Wait with cancellation check every 100ms
          await new Promise<void>((resolve) => {
            const checkInterval = 100; // Check every 100ms
            let elapsedTime = 0;

            const intervalId = setInterval(() => {
              elapsedTime += checkInterval;

              // Check for cancellation during wait
              if (isCancelled) {
                clearInterval(intervalId);
                resolve();
                return;
              }

              // Complete wait when interval is reached
              if (elapsedTime >= pollInterval) {
                clearInterval(intervalId);
                resolve();
                return;
              }
            }, checkInterval);
          });

          // Check for cancellation after waiting
          if (isCancelled) {
            const message = 'Authentication cancelled by user.';
            console.debug('\n' + message);
            qwenOAuth2Events.emit(
              QwenOAuth2Event.AuthProgress,
              'error',
              message,
            );
            return { success: false, reason: 'cancelled', message };
          }

          continue;
        }

        // Handle error response
        if (isErrorResponse(tokenResponse)) {
          const errorData = tokenResponse as ErrorData;
          throw new Error(
            `Token polling failed: ${errorData?.error || 'Unknown error'} - ${errorData?.error_description || 'No details provided'}`,
          );
        }
      } catch (error: unknown) {
        // Extract error information
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const statusCode =
          error instanceof Error
            ? (error as Error & { status?: number }).status
            : null;

        // Helper function to handle error and stop polling
        const handleError = (
          reason: 'error' | 'rate_limit',
          message: string,
          eventType: 'error' | 'rate_limit' = 'error',
        ): AuthResult => {
          qwenOAuth2Events.emit(
            QwenOAuth2Event.AuthProgress,
            eventType,
            message,
          );
          console.error('\n' + message);
          return { success: false, reason, message };
        };

        // Handle credential caching failures - stop polling immediately
        if (errorMessage.includes('Failed to cache credentials')) {
          return handleError('error', errorMessage);
        }

        // Handle 401 Unauthorized - device code expired or invalid
        if (errorMessage.includes('401') || statusCode === 401) {
          return handleError(
            'error',
            'Device code expired or invalid, please restart the authorization process.',
          );
        }

        // Handle 429 Too Many Requests - rate limiting
        if (errorMessage.includes('429') || statusCode === 429) {
          return handleError(
            'rate_limit',
            'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
            'rate_limit',
          );
        }

        const message = `Error polling for token: ${errorMessage}`;
        qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, 'error', message);

        if (isCancelled) {
          const message = 'Authentication cancelled by user.';
          return { success: false, reason: 'cancelled', message };
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    const timeoutMessage = 'Authorization timeout, please restart the process.';

    // Emit timeout error event
    qwenOAuth2Events.emit(
      QwenOAuth2Event.AuthProgress,
      'timeout',
      timeoutMessage,
    );

    console.error('\n' + timeoutMessage);
    return { success: false, reason: 'timeout', message: timeoutMessage };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `Device authorization flow failed: ${errorMessage}`;
    console.error(message);
    return { success: false, reason: 'error', message };
  } finally {
    // Clean up event listener
    qwenOAuth2Events.off(QwenOAuth2Event.AuthCancel, cancelHandler);
  }
}

async function loadCachedQwenCredentials(
  client: QwenOAuth2Client,
): Promise<boolean> {
  try {
    const keyFile = getQwenCachedCredentialPath();
    const creds = await fs.readFile(keyFile, 'utf-8');
    const credentials = JSON.parse(creds) as QwenCredentials;
    client.setCredentials(credentials);

    // Verify that the credentials are still valid
    const { token } = await client.getAccessToken();
    if (!token) {
      return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

async function cacheQwenCredentials(credentials: QwenCredentials) {
  const filePath = getQwenCachedCredentialPath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const credString = JSON.stringify(credentials, null, 2);
    await fs.writeFile(filePath, credString);
  } catch (error: unknown) {
    // Handle file system errors (e.g., EACCES permission denied)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof Error && 'code' in error
        ? (error as Error & { code?: string }).code
        : undefined;

    if (errorCode === 'EACCES') {
      throw new Error(
        `Failed to cache credentials: Permission denied (EACCES). Current user has no permission to access \`${filePath}\`. Please check permissions.`,
      );
    }

    // Throw error for other file system failures
    throw new Error(
      `Failed to cache credentials: error when creating folder \`${path.dirname(filePath)}\` and writing to \`${filePath}\`. ${errorMessage}. Please check permissions.`,
    );
  }
}

/**
 * Clear cached Qwen credentials from disk
 * This is useful when credentials have expired or need to be reset
 */
export async function clearQwenCredentials(): Promise<void> {
  try {
    const filePath = getQwenCachedCredentialPath();
    await fs.unlink(filePath);
    console.debug('Cached Qwen credentials cleared successfully.');
  } catch (error: unknown) {
    // If file doesn't exist or can't be deleted, we consider it cleared
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File doesn't exist, already cleared
      return;
    }
    // Log other errors but don't throw - clearing credentials should be non-critical
    console.warn('Warning: Failed to clear cached Qwen credentials:', error);
  }
}

function getQwenCachedCredentialPath(): string {
  return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
}
