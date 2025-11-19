/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

/**
 * Hook that handles initialization authentication error only once.
 * This ensures that if an auth error occurred during app initialization,
 * it is reported to the user exactly once, even if the component re-renders.
 *
 * @param authError - The authentication error from initialization, or null if no error.
 * @param onAuthError - Callback function to handle the authentication error.
 *
 * @example
 * ```tsx
 * useInitializationAuthError(
 *   initializationResult.authError,
 *   onAuthError
 * );
 * ```
 */
export const useInitializationAuthError = (
  authError: string | null,
  onAuthError: (error: string) => void,
): void => {
  const hasHandled = useRef(false);
  const authErrorRef = useRef(authError);
  const onAuthErrorRef = useRef(onAuthError);

  // Update refs to always use latest values
  authErrorRef.current = authError;
  onAuthErrorRef.current = onAuthError;

  useEffect(() => {
    if (hasHandled.current) {
      return;
    }

    if (authErrorRef.current) {
      hasHandled.current = true;
      onAuthErrorRef.current(authErrorRef.current);
    }
  }, [authError, onAuthError]);
};
