/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionResumeData } from '@qwen-code/core';
import { runLogger } from '@qwen-code/core';
import type {
  InteractiveProjectRuntime,
  RebuildInteractiveProject,
} from '../../interactiveProjectRuntime.js';
import type { SessionResumeOptions } from './useSessionResume.js';
import {
  clearSettingsCache,
  restoreLoadedEnvironment,
} from '../../config/settings.js';

export function useInteractiveProject(
  initial: InteractiveProjectRuntime,
  rebuild?: RebuildInteractiveProject,
) {
  const [runtime, setRuntime] = useState<InteractiveProjectRuntime | undefined>(
    initial,
  );
  const [error, setError] = useState<Error>();
  const [resumedSessionData, setResumedSessionData] =
    useState<SessionResumeData>();
  const [resumeOptions, setResumeOptions] = useState<SessionResumeOptions>();
  const unmounted = useRef<(() => void) | undefined>(undefined);
  const completed = useRef<((success: boolean) => void) | undefined>(undefined);
  const switching = useRef(false);
  const initialPromptSubmitted = useRef(false);

  useEffect(() => {
    if (!runtime) {
      unmounted.current?.();
      unmounted.current = undefined;
    }
  }, [runtime]);

  const resume = useCallback(
    async (
      data: SessionResumeData,
      options: SessionResumeOptions,
    ): Promise<boolean> => {
      if (!rebuild || !runtime || switching.current) return false;
      switching.current = true;
      const previous = runtime;
      // 等待旧项目子树卸载，避免 Provider 的订阅继续消费已经 dispose 的 Config。
      const didUnmount = new Promise<void>((resolve) => {
        unmounted.current = resolve;
      });
      setRuntime(undefined);
      await didUnmount;
      try {
        const next = await rebuild(previous.config, data);
        const didResume = new Promise<boolean>((resolve) => {
          completed.current = resolve;
        });
        setResumedSessionData(data);
        setResumeOptions(options);
        setRuntime(next);
        const success = await didResume;
        if (!success) {
          // Resume 失败的子树会先关闭 Writer，再通知此处释放项目资源。
          const didFailUnmount = new Promise<void>((resolve) => {
            unmounted.current = resolve;
          });
          setRuntime(undefined);
          await didFailUnmount;
          try {
            await next.config.dispose();
          } finally {
            restoreLoadedEnvironment();
            clearSettingsCache();
          }
          throw new Error('Failed to restore the selected session.');
        }
        return true;
      } catch (cause) {
        const failure =
          cause instanceof Error ? cause : new Error(String(cause));
        runLogger.warn('[session.resume] project_rebuild_failed', failure);
        setError(failure);
        return false;
      } finally {
        completed.current = undefined;
        switching.current = false;
      }
    },
    [rebuild, runtime],
  );

  const onInitialResumeComplete = useCallback((success: boolean) => {
    completed.current?.(success);
  }, []);

  return {
    runtime,
    error,
    resumedSessionData,
    resumeOptions,
    resume,
    onInitialResumeComplete,
    initialPromptSubmitted,
  };
}
