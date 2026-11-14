/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { isSubpath } from '../utils/paths.js';
import {
  IDE_MAX_OPEN_FILES,
  IDE_MAX_SELECTED_TEXT_LENGTH,
} from './constants.js';
import type { IdeContext } from './types.js';

type IdeContextSubscriber = (ideContext?: IdeContext) => void;

export class IdeContextStore {
  private ideContextState?: IdeContext;
  private workspaceRoots?: readonly string[];
  private readonly subscribers = new Set<IdeContextSubscriber>();

  /**
   * Notifies all registered subscribers about the current IDE context.
   */
  private notifySubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber(this.ideContextState);
    }
  }

  /**
   * Sets the IDE context and notifies all registered subscribers of the change.
   * @param newIdeContext The new IDE context from the IDE.
   */
  set(newIdeContext: IdeContext, workspaceRoots?: readonly string[]): void {
    this.workspaceRoots = workspaceRoots;
    const { workspaceState } = newIdeContext;
    if (!workspaceState) {
      this.ideContextState = newIdeContext;
      this.notifySubscribers();
      return;
    }

    const { openFiles } = workspaceState;

    if (openFiles && openFiles.length > 0) {
      // Sort by timestamp descending (newest first)
      openFiles.sort((a, b) => b.timestamp - a.timestamp);

      const mostRecentFile = openFiles[0];

      // If the most recent file is not active, then no file is active.
      if (!mostRecentFile.isActive) {
        openFiles.forEach((file) => {
          file.isActive = false;
          file.cursor = undefined;
          file.selectedText = undefined;
        });
      } else {
        // The most recent file is active. Ensure it's the only one.
        openFiles.forEach((file, index: number) => {
          if (index !== 0) {
            file.isActive = false;
            file.cursor = undefined;
            file.selectedText = undefined;
          }
        });

        if (
          mostRecentFile.selectedText &&
          mostRecentFile.selectedText.length > IDE_MAX_SELECTED_TEXT_LENGTH
        ) {
          mostRecentFile.selectedText =
            mostRecentFile.selectedText.substring(
              0,
              IDE_MAX_SELECTED_TEXT_LENGTH,
            ) + '... [TRUNCATED]';
        }
      }

      if (openFiles.length > IDE_MAX_OPEN_FILES) {
        workspaceState.openFiles = openFiles.slice(0, IDE_MAX_OPEN_FILES);
      }
    }
    this.ideContextState = newIdeContext;
    this.notifySubscribers();
  }

  /**
   * Clears the IDE context and notifies all registered subscribers of the change.
   */
  clear(): void {
    this.ideContextState = undefined;
    this.workspaceRoots = undefined;
    this.notifySubscribers();
  }

  /**
   * Retrieves the current IDE context.
   * @returns The `IdeContext` object if a file is active; otherwise, `undefined`.
   */
  get(): IdeContext | undefined {
    return this.ideContextState;
  }

  getWorkspaceTrust(workspaceDir: string): boolean | undefined {
    return this.getWorkspaceTrustScope(workspaceDir)?.isTrusted;
  }

  /**
   * The IDE's trust decision for `workspaceDir`, with the IDE workspace root
   * it comes from: the deepest root containing the directory. `root` is
   * absent when the IDE named no roots and the directory is the process cwd.
   */
  getWorkspaceTrustScope(
    workspaceDir: string,
  ): { isTrusted: boolean; root?: string } | undefined {
    const isTrusted = this.get()?.workspaceState?.isTrusted;
    if (isTrusted === undefined) return undefined;
    if (!this.workspaceRoots && workspaceDir === process.cwd()) {
      return { isTrusted };
    }
    try {
      const realpath = realpathSync.native ?? realpathSync;
      const canonicalDir = realpath(workspaceDir);
      if (!this.workspaceRoots) {
        return canonicalDir === realpath(process.cwd())
          ? { isTrusted }
          : undefined;
      }
      let root: string | undefined;
      for (const candidate of this.workspaceRoots) {
        if (
          isSubpath(candidate, canonicalDir) &&
          (root === undefined || candidate.length > root.length)
        ) {
          root = candidate;
        }
      }
      return root === undefined ? undefined : { isTrusted, root };
    } catch {
      return undefined;
    }
  }

  /**
   * Subscribes to changes in the IDE context.
   *
   * When the IDE context changes, the provided `subscriber` function will be called.
   * Note: The subscriber is not called with the current value upon subscription.
   *
   * @param subscriber The function to be called when the IDE context changes.
   * @returns A function that, when called, will unsubscribe the provided subscriber.
   */
  subscribe(subscriber: IdeContextSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

/**
 * The default, shared instance of the IDE context store for the application.
 */
export const ideContextStore = new IdeContextStore();
