/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents } from '../utils/events.js';

/**
 * Manages the current active topic title and tactical intent for a session.
 * Hosted within the Config instance for session-scoping.
 */
export class TopicState {
  private activeTopicTitle?: string;
  private activeIntent?: string;

  /**
   * sessionId 以 getter 注入而非快照：/resume、/clear、fork 之后会话归属会换，
   * 快照会把标题变更打到旧会话上。发射时实时读取（与 config.ts 的 getSessionId
   * 归属门禁同理）。
   */
  constructor(private readonly getSessionId: () => string) {}

  /**
   * Sanitizes and sets the topic title and/or intent.
   *
   * A changed title is announced on {@link CoreEvent.SessionTitleChanged}. This
   * is the one choke point every naming path shares — `/rename`, the `SetTopic`
   * tool, hook-supplied titles, `--name` and session resume — so subscribers
   * that care about the session's identity subscribe here rather than to any
   * one of them.
   *
   * @returns true if the input was valid and set, false otherwise.
   */
  setTopic(title?: string, intent?: string): boolean {
    const sanitizedTitle = title?.trim().replace(/[\r\n]+/g, ' ');
    const sanitizedIntent = intent?.trim().replace(/[\r\n]+/g, ' ');

    if (!sanitizedTitle && !sanitizedIntent) return false;

    const titleChanged =
      !!sanitizedTitle && sanitizedTitle !== this.activeTopicTitle;

    if (sanitizedTitle) {
      this.activeTopicTitle = sanitizedTitle;
    }

    if (sanitizedIntent) {
      this.activeIntent = sanitizedIntent;
    }

    if (titleChanged) {
      coreEvents.emitSessionTitleChanged(this.getSessionId(), sanitizedTitle);
    }

    return true;
  }

  getTopic(): string | undefined {
    return this.activeTopicTitle;
  }

  getIntent(): string | undefined {
    return this.activeIntent;
  }

  reset(): void {
    this.activeTopicTitle = undefined;
    this.activeIntent = undefined;
  }
}
