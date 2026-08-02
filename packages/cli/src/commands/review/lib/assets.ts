/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The deterministic half of `publish-assets`: names, URLs, and the validation
// gate for evidence images headed to the user-designated assets repository.
//
// GitHub's API has no endpoint for the drag-and-drop image uploads the web UI
// enjoys, so a review that wants an image in a PR comment must host it
// somewhere durable and reference it by URL. The designated repo (the
// `QWEN_REVIEW_ASSETS_REPO` env var — the same user-designation pattern as
// `QWEN_REVIEW_SCRATCH_REPO`, and deliberately a DIFFERENT variable: the
// scratch repo's contract forbids PR-derived content, and a screenshot of the
// PR's behaviour is exactly that) is the durable place; this file decides what
// goes there and under what name.
//
// Everything here is pure so the naming and validation rules are unit-testable
// without a GitHub, a filesystem, or a mock. The command layer owns I/O.

/** The extensions an evidence image may carry. An allowlist, not a denylist:
 * SVG is deliberately absent (it is a script container), and anything
 * non-image is refused rather than hosted — this command publishes review
 * evidence, not arbitrary files. */
export const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Per-file and per-run size caps. Evidence screenshots are hundreds of
 * kilobytes; a cap far above that catches the accidental screen-recording or
 * bundled binary without ever bothering a legitimate run. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 40 * 1024 * 1024;

/** The branch all of one PR's review evidence lands on. Mirrors the manual
 * convention this feature grew from (`pr-assets/<PR>-verify`), with a
 * `-review` suffix so hand-published and review-published evidence never
 * collide. */
export function assetsBranch(pr: number): string {
  return `pr-assets/${pr}-review`;
}

/**
 * The path a file takes inside the assets repo.
 *
 * Content-hash prefixed, for two properties a bare basename lacks: two
 * different files that happen to share a name (`before.png` from two findings)
 * cannot collide, and the same file published twice lands on the same path —
 * a natural dedupe that makes re-runs idempotent instead of accumulative.
 */
export function remoteAssetPath(
  pr: number,
  basename: string,
  sha256Hex: string,
): string {
  // The basename is user-controlled input headed into a URL and a git path;
  // keep only a conservative charset and let the hash carry uniqueness.
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${pr}-review/${sha256Hex.slice(0, 12)}-${safe}`;
}

/**
 * The URL a published asset is referenced by in a PR comment.
 *
 * Pinned to the COMMIT, not the branch, for two reasons. Immutability: a
 * comment's evidence must keep meaning what it meant when posted, and a
 * branch-addressed URL re-resolves on every push. And unambiguity: the branch
 * name contains a slash, and slash-named refs in raw URLs are resolved by
 * greedy matching that a same-prefix ref can break.
 *
 * The web-host `/raw/` redirect form rather than `raw.githubusercontent.com`,
 * because it is the one shape that works unchanged on GitHub Enterprise hosts
 * (which have no `raw.` subdomain by default) — and on github.com it is a
 * redirect GitHub's own image proxy follows.
 */
export function rawAssetUrl(opts: {
  host?: string;
  repo: string;
  commitSha: string;
  remotePath: string;
}): string {
  const host = opts.host && opts.host.trim() !== '' ? opts.host : 'github.com';
  return `https://${host}/${opts.repo}/raw/${opts.commitSha}/${opts.remotePath}`;
}

/** `owner/repo`, structurally — the same charset GitHub itself enforces, so a
 * value that parses here is safe to interpolate into an API path. */
export function parseAssetsRepo(
  value: string | undefined,
): { repo: string } | { error: string } {
  const v = (value ?? '').trim();
  if (v === '') {
    return {
      error:
        'QWEN_REVIEW_ASSETS_REPO is not set. Designate an assets repository ' +
        '(owner/repo you can push to — the repo under review for maintainers, ' +
        'a fork or scratch repo otherwise) to publish review evidence images.',
    };
  }
  const parts = v.split('/');
  const segmentOk = (p: string) =>
    /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..';
  // `.` and `..` are made of legal characters and mean something else entirely
  // once they reach a URL path — the same rule submit's isRepo enforces for
  // the repo IT interpolates. `owner/..` here is a typo that would otherwise
  // fail as a confusing 404 three calls later.
  if (parts.length !== 2 || !parts.every(segmentOk)) {
    return {
      error: `QWEN_REVIEW_ASSETS_REPO must be owner/repo, got ${JSON.stringify(v)}.`,
    };
  }
  return { repo: v };
}

/** One file's admission ruling. `bytes` comes from the command layer's stat. */
export function validateAssetFile(
  basename: string,
  bytes: number,
): { ok: true } | { ok: false; reason: string } {
  const ext = basename.includes('.')
    ? basename.slice(basename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (!ASSET_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason:
        `${basename}: extension ${JSON.stringify(ext)} is not an allowed ` +
        `evidence image type (${[...ASSET_EXTENSIONS].join(', ')})`,
    };
  }
  if (bytes <= 0) {
    return { ok: false, reason: `${basename}: empty file` };
  }
  if (bytes > MAX_ASSET_BYTES) {
    return {
      ok: false,
      reason:
        `${basename}: ${bytes} bytes exceeds the per-file cap of ` +
        `${MAX_ASSET_BYTES} bytes`,
    };
  }
  return { ok: true };
}

/**
 * The whole batch's admission ruling — per-file rules plus the aggregate cap.
 *
 * Pure, so the 40MB total cap is testable without writing 40MB of fixtures:
 * the command stats the files and hands the sizes here.
 */
export function validateAssetBatch(
  files: ReadonlyArray<{ basename: string; bytes: number }>,
): { ok: true } | { ok: false; reason: string } {
  let total = 0;
  for (const f of files) {
    const one = validateAssetFile(f.basename, f.bytes);
    if (!one.ok) return one;
    total += f.bytes;
    if (total > MAX_TOTAL_ASSET_BYTES) {
      return {
        ok: false,
        reason: `total size exceeds ${MAX_TOTAL_ASSET_BYTES} bytes`,
      };
    }
  }
  return { ok: true };
}

/** One published file, as the manifest records it. */
export interface PublishedAsset {
  /** The local path the file was read from. */
  file: string;
  /** The path inside the assets repo. */
  remotePath: string;
  /** The commit-pinned URL a PR comment references. */
  url: string;
  bytes: number;
  sha256: string;
}

/** The manifest `publish-assets` writes — the auditable record of the one
 * write this command performed, mirroring how `submit` records what it posted. */
export interface AssetsManifest {
  repo: string;
  branch: string;
  /** The branch head after the last upload; every URL is pinned to it. */
  commitSha: string;
  pr: number;
  published: PublishedAsset[];
}
