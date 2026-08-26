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

/** The four admitted image formats — the values `EXTENSION_FORMAT` maps to
 * and `sniffImageFormat` returns. */
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** The container format each allowed extension claims to carry — and the
 * allowlist's single source of truth: `ASSET_EXTENSIONS` derives from these
 * keys. Admitting a format is a two-place change: add the key here AND the
 * matching `sniffImageFormat` branch below, or the content gate refuses
 * every real file of the new format (the "two gates agree" pin in
 * `assets.test.ts` fails CI and names which admission is dead).
 * An allowlist, not a denylist: SVG is deliberately absent (it is a script
 * container), and anything non-image is refused rather than hosted — this
 * command publishes review evidence, not arbitrary files. */
const EXTENSION_FORMAT: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
};

/** The extensions an evidence image may carry. */
export const ASSET_EXTENSIONS = new Set(Object.keys(EXTENSION_FORMAT));

/** The lowercased extension a basename claims, or '' when it claims none. */
function claimedExtension(basename: string): string {
  return basename.includes('.')
    ? basename.slice(basename.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

/** How many leading bytes `sniffImageFormat` needs to rule — the longest
 * admitted signature (WEBP's fourcc ends at byte 15) fits inside. Admitting a
 * format with a longer signature means raising this, or every real file of it
 * false-refuses at publish time while full-header unit tests stay green. */
export const ASSET_HEADER_BYTES = 16;

/**
 * Detect the image format from a file's first bytes.
 *
 * The allowlist above is extension-based, and an extension is a claim anyone
 * can make: without content sniffing, a shell script renamed `evidence.png`
 * publishes through a review's evidence push. This check binds the CLAIMED
 * type to the leading bytes — it does not stop a prefixed payload (arbitrary
 * bytes riding behind a genuine signature still pass; closing that needs
 * decode-and-reencode, out of scope here). The signatures vary in strength:
 * WEBP is checked across 16 bytes, PNG across 8, GIF across 6, and JPEG
 * across only 3.
 *
 * A sibling signature table lives in core: `sniffFileKind` in
 * `packages/core/src/utils/binary-content.ts` (best-effort kind detection for
 * fetched web content, deliberately looser). Admitting or correcting a format
 * here means checking that site too.
 */
export function sniffImageFormat(header: Uint8Array): ImageFormat | null {
  const at = (i: number): number => header[i] ?? -1;
  const ascii = (i: number, s: string): boolean =>
    [...s].every((ch, k) => at(i + k) === ch.charCodeAt(0));
  if (
    at(0) === 0x89 &&
    ascii(1, 'PNG') &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return 'png';
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'jpeg';
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return 'gif';
  }
  if (
    ascii(0, 'RIFF') &&
    ascii(8, 'WEBP') &&
    // The container claim is not the image: a RIFF box carrying WEBP at
    // offset 8 could still hold anything. Every spec-conformant WebP's
    // first chunk is VP8, VP8L or VP8X at byte 12, and the 16-byte read
    // this gate sniffs always covers it.
    (ascii(12, 'VP8 ') || ascii(12, 'VP8L') || ascii(12, 'VP8X'))
  ) {
    return 'webp';
  }
  return null;
}

/** The allowlist refusal, built in one place so `validateAssetFile` and
 * `validateAssetContent` cannot drift. */
function refusedExtension(
  basename: string,
  ext: string,
): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      `${basename}: extension ${JSON.stringify(ext)} is not an allowed ` +
      `evidence image type (${[...ASSET_EXTENSIONS].join(', ')})`,
  };
}

/**
 * Rule on a file's CONTENT against the format its extension claims. Pure —
 * the caller hands over the first bytes — and fail-closed: an unrecognized
 * signature refuses even when the extension is allowed.
 */
export function validateAssetContent(
  basename: string,
  header: Uint8Array,
): { ok: true } | { ok: false; reason: string } {
  const ext = claimedExtension(basename);
  // hasOwn, not a bare index: `__proto__`/`constructor` extensions would
  // otherwise resolve to Object.prototype values and skip this refusal.
  const claimed = Object.hasOwn(EXTENSION_FORMAT, ext)
    ? EXTENSION_FORMAT[ext]
    : undefined;
  if (claimed === undefined) {
    return refusedExtension(basename, ext);
  }
  const actual = sniffImageFormat(header);
  if (actual !== claimed) {
    // No basename prefix, unlike the shared extension refusal: the publish
    // loop refuses with the full quoted path once, and a second name reads
    // as a stutter to the operator.
    return {
      ok: false,
      reason:
        `content is ${actual ?? 'not a recognized image'} but the ` +
        `extension claims ${claimed} — evidence is admitted by content, ` +
        `not by name`,
    };
  }
  return { ok: true };
}

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
  const ext = claimedExtension(basename);
  if (!ASSET_EXTENSIONS.has(ext)) {
    return refusedExtension(basename, ext);
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
