/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { MemoryTaskRecord } from '@qwen-code/qwen-code-core/memory/manager.js';
import type { PendingSkillView } from '../contexts/UIStateContext.js';

export interface NativeSkillReviewBatch {
  generation: number;
  config: Config;
  manager: ReturnType<Config['getMemoryManager']>;
  task: MemoryTaskRecord;
  skills: PendingSkillView[];
  isCurrent: () => boolean;
  isDismissed: () => boolean;
  dismiss: () => void;
}
export interface NativeSkillReviewController {
  pending: NativeSkillReviewBatch | null;
  canDrain: () => boolean;
  setUiBlocked: (blocked: boolean) => void;
}

export function useSkillReview(config: Config): NativeSkillReviewController {
  const latest = useRef(config);
  latest.current = config;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = {
    config,
    manager: config.getMemoryManager(),
    project: config.getProjectRoot(),
    session: config.getSessionId(),
    cwd: config.getWorkingDir(),
  };
  const generation = useRef({
    ...current,
    uiBlocked: false,
    revoked: false,
    dismissed: new Set<string>(),
  });
  const previous = generation.current;
  if (
    previous.config !== current.config ||
    previous.manager !== current.manager ||
    previous.project !== current.project ||
    previous.session !== current.session ||
    previous.cwd !== current.cwd
  ) {
    previous.revoked = true;
    generation.current = {
      ...current,
      uiBlocked: false,
      revoked: false,
      dismissed: new Set<string>(),
    };
  }
  const owner = generation.current;
  const active = useCallback(() => {
    if (!mounted.current || owner.revoked || generation.current !== owner)
      return false;
    const now = latest.current;
    if (
      now !== owner.config ||
      now.getMemoryManager() !== owner.manager ||
      now.getProjectRoot() !== owner.project ||
      now.getSessionId() !== owner.session ||
      now.getWorkingDir() !== owner.cwd
    ) {
      owner.revoked = true;
      return false;
    }
    return true;
  }, [owner]);
  const selectTask = useCallback(
    () =>
      owner.manager
        .listTasksByType('skill-review', owner.project)
        .find(
          (item) =>
            Array.isArray(item.metadata?.['pendingSkills']) &&
            item.metadata['pendingSkills'].length > 0,
        ),
    [owner],
  );
  const canDrain = useCallback(() => {
    if (!active() || owner.uiBlocked) return false;
    if (!owner.config.getAutoSkillEnabled()) return true;
    const task = selectTask();
    return !task || owner.dismissed.has(task.id);
  }, [active, owner, selectTask]);
  const selectionSequence = useRef(0);
  const [pending, setPending] = useState<NativeSkillReviewBatch | null>(null);
  useEffect(() => {
    let disposed = false;
    let signature = '';
    let selectedTask: MemoryTaskRecord | undefined;
    let selection = { revoked: false, id: 0 };
    const refresh = () => {
      if (disposed) return;
      if (!active()) {
        if (generation.current === owner) setPending(null);
        return;
      }
      const task = selectTask();
      const skills = task?.metadata?.['pendingSkills'] as
        | PendingSkillView[]
        | undefined;
      const next =
        task && skills
          ? JSON.stringify([
              task.id,
              skills.map(({ name, description, stagedManifestPath }) => [
                name,
                description,
                stagedManifestPath,
              ]),
            ])
          : '';
      if (next === signature && task === selectedTask) return;
      if (task !== selectedTask) {
        selection.revoked = true;
        selection = { revoked: false, id: ++selectionSequence.current };
      }
      selectedTask = task;
      signature = next;
      const lease = selection;
      const isCurrent = () => {
        if (lease.revoked || !task) return false;
        if (
          !active() ||
          owner.manager.getTask(task.id) !== task ||
          task.projectRoot !== owner.project
        ) {
          lease.revoked = true;
          return false;
        }
        return true;
      };
      setPending(
        task && skills
          ? {
              generation: lease.id,
              config: owner.config,
              manager: owner.manager,
              task,
              skills: skills.map((skill) => ({ ...skill })),
              isCurrent,
              isDismissed: () => owner.dismissed.has(task.id),
              dismiss: () => {
                if (isCurrent()) owner.dismissed.add(task.id);
              },
            }
          : null,
      );
    };
    const unsubscribe = owner.manager.subscribe(refresh, {
      taskType: 'skill-review',
    });
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, owner, selectTask]);
  const setUiBlocked = useCallback(
    (blocked: boolean) => {
      if (generation.current === owner && !owner.revoked)
        owner.uiBlocked = blocked;
    },
    [owner],
  );
  return {
    pending: pending?.config === config && pending.isCurrent() ? pending : null,
    canDrain,
    setUiBlocked,
  };
}
