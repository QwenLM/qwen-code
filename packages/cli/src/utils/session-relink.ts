/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import prompts from 'prompts';
import {
  SessionService,
  type SessionRelinkLookupResult,
  type SessionRelinkMutationResult,
} from '@qwen-code/qwen-code-core/services/sessionService.js';

interface RelinkSessionService {
  getSessionLocation(
    sessionId: string,
  ): Promise<'active' | 'archived' | 'conflict' | undefined>;
  findRelinkCandidate(sessionId: string): Promise<SessionRelinkLookupResult>;
  relinkSession(
    candidate: Extract<
      SessionRelinkLookupResult,
      { status: 'candidate' }
    >['candidate'],
  ): Promise<SessionRelinkMutationResult>;
}

export type ResumeSessionRelinkResult =
  | { status: 'unchanged' }
  | { status: 'relinked'; previousCwd: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; message: string };

function blockedMessage(result: SessionRelinkLookupResult): string {
  if (result.status === 'ambiguous') {
    const directories = [
      ...new Set(
        result.matches
          .map((match) => match.recordedCwd)
          .filter((cwd): cwd is string => cwd !== undefined),
      ),
    ];
    const locations =
      directories.length > 0
        ? ` Recorded project directories: ${directories.join(', ')}.`
        : '';
    return (
      'More than one saved session has this ID in another project. ' +
      'Qwen Code did not move any files; remove the duplicate or resume from the original directory.' +
      locations
    );
  }
  if (result.status !== 'blocked') return '';
  switch (result.reason) {
    case 'active_writer':
      return 'The saved session appears to be active in another Qwen Code process, so it cannot be reattached.';
    case 'invalid_transcript':
      return 'The saved session transcript is incomplete or invalid, so it cannot be safely reattached.';
    case 'managed_session':
      return "This session belongs to Qwen Code's managed session engine and cannot be reattached by the legacy project-move flow.";
    case 'source_directory_exists':
      return (
        `The session still belongs to an existing project directory (${result.recordedCwd ?? 'unknown'}). ` +
        'Resume it from that directory instead.'
      );
    case 'target_conflict':
      return 'A session artifact with this ID already exists for the current project, so Qwen Code did not overwrite it.';
    case 'scan_incomplete':
      return (
        'Qwen Code could not safely complete the saved-session search, so it did not move any files.' +
        (result.detail ? ` ${result.detail}` : '')
      );
    case 'source_unavailable':
      return (
        'The saved session changed or became unavailable while Qwen Code was checking it.' +
        (result.detail ? ` ${result.detail}` : '')
      );
    default:
      return 'The saved session cannot be safely reattached.';
  }
}

export async function maybeRelinkResumeSession(options: {
  sessionId: string;
  cwd: string;
  interactive: boolean;
  service?: RelinkSessionService;
  confirm?: (message: string) => Promise<boolean>;
}): Promise<ResumeSessionRelinkResult> {
  const service = options.service ?? new SessionService(options.cwd);
  if ((await service.getSessionLocation(options.sessionId)) !== undefined) {
    return { status: 'unchanged' };
  }

  const lookup = await service.findRelinkCandidate(options.sessionId);
  if (lookup.status === 'not_found') return { status: 'unchanged' };
  if (lookup.status !== 'candidate') {
    return { status: 'blocked', message: blockedMessage(lookup) };
  }
  if (!options.interactive) {
    return {
      status: 'blocked',
      message:
        'This session was saved under a project directory that no longer exists. ' +
        `Run \`qwen --resume ${options.sessionId}\` in an interactive terminal from the moved project to review and confirm reattachment.`,
    };
  }

  const message =
    `Session ${options.sessionId} was saved for the missing project directory ` +
    `"${lookup.candidate.recordedCwd}". Reattach it to "${options.cwd}"?`;
  const confirmed = options.confirm
    ? await options.confirm(message)
    : (
        await prompts({
          type: 'confirm',
          name: 'confirmed',
          message,
          initial: false,
        })
      ).confirmed === true;
  if (!confirmed) return { status: 'cancelled' };

  try {
    const mutation = await service.relinkSession(lookup.candidate);
    if (mutation.status === 'blocked') {
      return { status: 'blocked', message: blockedMessage(mutation.result) };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'blocked',
      message: `Qwen Code could not safely complete session reattachment: ${detail}`,
    };
  }
  return {
    status: 'relinked',
    previousCwd: lookup.candidate.recordedCwd,
  };
}
