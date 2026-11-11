/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonGitHubPullRequestList } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { DialogShell } from './DialogShell';

export interface BindSessionPrPayload {
  number: number;
  url: string;
  state?: 'open' | 'merged' | 'closed';
}

interface BindSessionPrDialogProps {
  workspaceCwd: string;
  busy: boolean;
  /** Daemon-side failure surfaced by the panel; resolution errors are internal. */
  error?: string;
  onSubmit: (pr: BindSessionPrPayload) => void;
  onClose: () => void;
}

// Mirrors the core pullRequestViewUrl rules without importing it (that
// module pulls node:fs into the client bundle): http(s), a [\w.-] owner/repo,
// lowercase /pull/<n>, optional subpath or .diff/.patch suffix. Rebuilding
// from the parsed URL drops userinfo (credentials) and query/fragment, and
// /PULL/ fails closed to the invalid-input message like every other core
// canonicalizer. The safe-integer check keeps an over-long number out.
const PR_URL_PATH =
  /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|\.diff$|\.patch$|$)/;
const BARE_NUMBER_PATTERN = /^[1-9]\d{0,8}$/;

function canonicalPrUrl(
  input: string,
): { number: number; url: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  const match = PR_URL_PATH.exec(parsed.pathname);
  const number = match ? Number(match[3]) : Number.NaN;
  if (!match || !Number.isSafeInteger(number) || number < 1) return undefined;
  const [, owner, repo] = match;
  return {
    number,
    url: `${parsed.protocol}//${parsed.host}/${owner}/${repo}/pull/${number}`,
  };
}

// The daemon answers a missing/unauthenticated gh with this code; surface the
// install guidance instead of "paste the URL" (a URL bind would persist a
// state the refresh sweep can never resolve without gh). Mirrors the
// module-private errorCode() in GitHubPrsDialog.tsx.
function daemonErrorCode(error: unknown): unknown {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined;
  return body && typeof body === 'object'
    ? (body as { code?: unknown }).code
    : undefined;
}

/**
 * Supplementary PR registration: binds an existing PR the automatic paths
 * missed. A URL binds normalized to its canonical /pull/<N> spelling (the
 * daemon's refresh sweep resolves its state); a bare number or #N resolves
 * through the workspace's open-PR list, so a number outside that list
 * (merged/closed or beyond the list cap) asks for the URL.
 */
export function BindSessionPrDialog({
  workspaceCwd,
  busy,
  error,
  onSubmit,
  onClose,
}: BindSessionPrDialogProps) {
  const { client } = useWorkspace();
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const [resolving, setResolving] = useState(false);
  const [prList, setPrList] = useState<DaemonGitHubPullRequestList | null>(
    null,
  );
  // A cancelled dialog must not submit the in-flight resolution: the
  // parent's guard reads a closure-captured target and runs unconditionally,
  // so the liveness check lives here, after every await.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const submit = async () => {
    const input = value.trim().replace(/^#/, '');
    setLocalError(undefined);

    const canonical = canonicalPrUrl(input);
    if (canonical) {
      onSubmit(canonical);
      return;
    }

    if (!BARE_NUMBER_PATTERN.test(input)) {
      setLocalError(t('sessionsOverview.bindPrInvalid'));
      return;
    }
    const number = Number(input);

    let list = prList;
    if (!list) {
      // A cwd-less legacy session has no workspace PR list to resolve
      // against; asking for the URL beats a request no route resolves.
      if (!workspaceCwd) {
        setLocalError(t('sessionsOverview.bindPrListFailed'));
        return;
      }
      setResolving(true);
      try {
        list = await client
          .workspaceByCwd(workspaceCwd)
          .workspaceGitHubPullRequests();
        if (!aliveRef.current) return;
        setPrList(list);
      } catch (err) {
        if (aliveRef.current) {
          setLocalError(
            daemonErrorCode(err) === 'github_cli_unavailable'
              ? t('githubPrs.cliUnavailable')
              : t('sessionsOverview.bindPrListFailed'),
          );
        }
        return;
      } finally {
        if (aliveRef.current) setResolving(false);
      }
    }
    if (!aliveRef.current) return;
    if (!list.available) {
      setLocalError(t('sessionsOverview.bindPrUnavailable'));
      return;
    }
    const match = list.pullRequests.find((pr) => pr.number === number);
    if (!match) {
      setLocalError(
        t('sessionsOverview.bindPrNotInList', { number: String(number) }),
      );
      return;
    }
    // The list only carries open/draft PRs; draft records as open.
    onSubmit({ number: match.number, url: match.url, state: 'open' });
  };

  // A fresh local validation message outranks the host's stale daemon
  // error; editing clears the local one so it never describes input the
  // user already replaced.
  const shownError = localError ?? error;
  const disabled = busy || resolving || !value.trim();

  // Both phases stay dismissible: the aliveRef guard already prevents a
  // closed dialog from submitting, so trapping the user behind a slow list
  // fetch would be strictly worse. aria-busy conveys the in-flight state.
  return (
    <DialogShell
      title={t('sessionsOverview.bindPr')}
      size="sm"
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        aria-busy={busy || resolving}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) void submit();
        }}
      >
        <Input
          autoFocus
          aria-label={t('sessionsOverview.bindPr')}
          placeholder={t('sessionsOverview.bindPrPlaceholder')}
          maxLength={2048}
          value={value}
          disabled={busy || resolving}
          onChange={(event) => {
            setValue(event.target.value);
            if (localError) setLocalError(undefined);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229)
            ) {
              event.preventDefault();
            }
          }}
        />
        {shownError && (
          <p role="alert" className="text-sm text-destructive">
            {shownError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={disabled}>
            {t('sessionsOverview.bindPrSubmit')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
