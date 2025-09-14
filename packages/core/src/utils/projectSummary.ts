/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Represents the structured information extracted from a `PROJECT_SUMMARY.md` file.
 */
export interface ProjectSummaryInfo {
  /**
   * Indicates whether a project summary file was found.
   */
  hasHistory: boolean;
  /**
   * The full content of the project summary file.
   */
  content?: string;
  /**
   * The timestamp of the last update to the summary file.
   */
  timestamp?: string;
  /**
   * A human-readable string representing the time since the last update (e.g., "2 hours ago").
   */
  timeAgo?: string;
  /**
   * The content of the "Overall Goal" section.
   */
  goalContent?: string;
  /**
   * The content of the "Current Plan" section.
   */
  planContent?: string;
  /**
   * The total number of tasks in the plan.
   */
  totalTasks?: number;
  /**
   * The number of tasks marked as "[DONE]".
   */
  doneCount?: number;
  /**
   * The number of tasks marked as "[IN PROGRESS]".
   */
  inProgressCount?: number;
  /**
   * The number of tasks marked as "[TODO]".
   */
  todoCount?: number;
  /**
   * An array of the first few pending tasks (TODO or IN PROGRESS).
   */
  pendingTasks?: string[];
}

/**
 * Reads and parses the `PROJECT_SUMMARY.md` file from the `.qwen` directory
 * to extract structured information about the project's status, goal, and plan.
 *
 * @returns A promise that resolves to a `ProjectSummaryInfo` object.
 *          If the summary file is not found, `hasHistory` will be `false`.
 */
export async function getProjectSummaryInfo(): Promise<ProjectSummaryInfo> {
  const summaryPath = path.join(process.cwd(), '.qwen', 'PROJECT_SUMMARY.md');

  try {
    await fs.access(summaryPath);
  } catch {
    return {
      hasHistory: false,
    };
  }

  try {
    const content = await fs.readFile(summaryPath, 'utf-8');

    // Extract timestamp if available
    const timestampMatch = content.match(/\*\*Update time\*\*: (.+)/);

    const timestamp = timestampMatch
      ? timestampMatch[1]
      : new Date().toISOString();

    // Calculate time ago
    const getTimeAgo = (timestamp: string) => {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays > 0) {
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      } else if (diffHours > 0) {
        return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      } else if (diffMinutes > 0) {
        return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
      } else {
        return 'just now';
      }
    };

    const timeAgo = getTimeAgo(timestamp);

    // Parse Overall Goal section
    const goalSection = content.match(
      /## Overall Goal\s*\n?([\s\S]*?)(?=\n## |$)/,
    );
    const goalContent = goalSection ? goalSection[1].trim() : '';

    // Parse Current Plan section
    const planSection = content.match(
      /## Current Plan\s*\n?([\s\S]*?)(?=\n## |$)/,
    );
    const planContent = planSection ? planSection[1] : '';
    const planLines = planContent.split('\n').filter((line) => line.trim());
    const doneCount = planLines.filter((line) =>
      line.includes('[DONE]'),
    ).length;
    const inProgressCount = planLines.filter((line) =>
      line.includes('[IN PROGRESS]'),
    ).length;
    const todoCount = planLines.filter((line) =>
      line.includes('[TODO]'),
    ).length;
    const totalTasks = doneCount + inProgressCount + todoCount;

    // Extract pending tasks
    const pendingTasks = planLines
      .filter(
        (line) => line.includes('[TODO]') || line.includes('[IN PROGRESS]'),
      )
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .slice(0, 3);

    return {
      hasHistory: true,
      content,
      timestamp,
      timeAgo,
      goalContent,
      planContent,
      totalTasks,
      doneCount,
      inProgressCount,
      todoCount,
      pendingTasks,
    };
  } catch (_error) {
    return {
      hasHistory: false,
    };
  }
}
