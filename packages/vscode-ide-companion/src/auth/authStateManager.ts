/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';

interface AuthState {
  isAuthenticated: boolean;
  authMethod: string;
  timestamp: number;
  workingDir?: string;
}

/**
 * Manages authentication state caching to avoid repeated logins
 */
export class AuthStateManager {
  private static readonly AUTH_STATE_KEY = 'qwen.authState';
  private static readonly AUTH_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Check if there's a valid cached authentication
   */
  async hasValidAuth(workingDir: string, authMethod: string): Promise<boolean> {
    const state = await this.getAuthState();

    if (!state) {
      console.log('[AuthStateManager] No cached auth state found');
      return false;
    }

    console.log('[AuthStateManager] Found cached auth state:', {
      workingDir: state.workingDir,
      authMethod: state.authMethod,
      timestamp: new Date(state.timestamp).toISOString(),
      isAuthenticated: state.isAuthenticated,
    });
    console.log('[AuthStateManager] Checking against:', {
      workingDir,
      authMethod,
    });

    // Check if auth is still valid (within cache duration)
    const now = Date.now();
    const isExpired =
      now - state.timestamp > AuthStateManager.AUTH_CACHE_DURATION;

    if (isExpired) {
      console.log('[AuthStateManager] Cached auth expired');
      console.log(
        '[AuthStateManager] Cache age:',
        Math.floor((now - state.timestamp) / 1000 / 60),
        'minutes',
      );
      await this.clearAuthState();
      return false;
    }

    // Check if it's for the same working directory and auth method
    const isSameContext =
      state.workingDir === workingDir && state.authMethod === authMethod;

    if (!isSameContext) {
      console.log('[AuthStateManager] Working dir or auth method changed');
      console.log('[AuthStateManager] Cached workingDir:', state.workingDir);
      console.log('[AuthStateManager] Current workingDir:', workingDir);
      console.log('[AuthStateManager] Cached authMethod:', state.authMethod);
      console.log('[AuthStateManager] Current authMethod:', authMethod);
      return false;
    }

    console.log('[AuthStateManager] Valid cached auth found');
    return state.isAuthenticated;
  }

  /**
   * Force check auth state without clearing cache
   * This is useful for debugging to see what's actually cached
   */
  async debugAuthState(): Promise<void> {
    const state = await this.getAuthState();
    console.log('[AuthStateManager] DEBUG - Current auth state:', state);

    if (state) {
      const now = Date.now();
      const age = Math.floor((now - state.timestamp) / 1000 / 60);
      const isExpired =
        now - state.timestamp > AuthStateManager.AUTH_CACHE_DURATION;

      console.log('[AuthStateManager] DEBUG - Auth state age:', age, 'minutes');
      console.log('[AuthStateManager] DEBUG - Auth state expired:', isExpired);
      console.log(
        '[AuthStateManager] DEBUG - Auth state valid:',
        state.isAuthenticated,
      );
    }
  }

  /**
   * Save successful authentication state
   */
  async saveAuthState(workingDir: string, authMethod: string): Promise<void> {
    const state: AuthState = {
      isAuthenticated: true,
      authMethod,
      workingDir,
      timestamp: Date.now(),
    };

    console.log('[AuthStateManager] Saving auth state:', {
      workingDir,
      authMethod,
      timestamp: new Date(state.timestamp).toISOString(),
    });

    await this.context.globalState.update(
      AuthStateManager.AUTH_STATE_KEY,
      state,
    );
    console.log('[AuthStateManager] Auth state saved');

    // Verify the state was saved correctly
    const savedState = await this.getAuthState();
    console.log('[AuthStateManager] Verified saved state:', savedState);
  }

  /**
   * Clear authentication state
   */
  async clearAuthState(): Promise<void> {
    console.log('[AuthStateManager] Clearing auth state');
    const currentState = await this.getAuthState();
    console.log(
      '[AuthStateManager] Current state before clearing:',
      currentState,
    );

    await this.context.globalState.update(
      AuthStateManager.AUTH_STATE_KEY,
      undefined,
    );
    console.log('[AuthStateManager] Auth state cleared');

    // Verify the state was cleared
    const newState = await this.getAuthState();
    console.log('[AuthStateManager] State after clearing:', newState);
  }

  /**
   * Get current auth state
   */
  private async getAuthState(): Promise<AuthState | undefined> {
    const a = this.context.globalState.get<AuthState>(
      AuthStateManager.AUTH_STATE_KEY,
    );
    console.log('[AuthStateManager] Auth state:', a);
    return a;
  }

  /**
   * Get auth state info for debugging
   */
  async getAuthInfo(): Promise<string> {
    const state = await this.getAuthState();
    if (!state) {
      return 'No cached auth';
    }

    const age = Math.floor((Date.now() - state.timestamp) / 1000 / 60);
    return `Auth cached ${age}m ago, method: ${state.authMethod}`;
  }
}
