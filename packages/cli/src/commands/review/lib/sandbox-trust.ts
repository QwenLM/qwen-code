/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { isFileSourcedEnvKey } from '../../../config/environment.js';

export type ReviewPrTrust =
  | 'local-owner'
  | 'collaborator'
  | 'external'
  | 'unknown';

export type ReviewExecutionClass =
  | 'trusted-shared-kernel'
  | 'hardware-isolated';

/**
 * How a report describes an execution that had no trust context to classify
 * (e.g. a host `tmux` drive under `off`/`auto`, or a phase that was refused
 * before a plan was consulted). Distinct from `hardware-isolated`, which is a
 * real classification that forbids shared-kernel execution.
 */
export type ReviewBoundaryExecutionClass =
  | ReviewExecutionClass
  | 'unclassified';

export type ReviewSandboxBackend =
  | 'direct'
  | 'container'
  | 'firecracker'
  | 'vfkit'
  | 'provider-vm'
  | 'refused';

export type ReviewTeardownStatus =
  | 'clean'
  | 'partial'
  | 'failed'
  | 'not-applicable';

export interface ReviewChangedFile {
  path: string;
  renameFrom?: string;
  mode?: string;
  binary?: boolean;
}

export interface ReviewTrustInput {
  /** True for local-diff / file-path reviews with no PR target. */
  isLocal?: boolean;
  /** True when the PR head lives in a fork repository. */
  isCrossRepository?: boolean;
  /** GitHub author_association value (e.g. OWNER, MEMBER, COLLABORATOR, NONE). */
  authorAssociation?: string;
  /**
   * Files touched by the diff. For non-local PR reviews, omitting this list
   * fails closed to `hardware-isolated` so mandatory escalations cannot be
   * bypassed by missing metadata.
   */
  changedFiles?: ReviewChangedFile[];
  /**
   * True when `changedFiles` is known to be incomplete (e.g. an incremental
   * delta-narrowed round or a plan whose file list disagrees with `diffStat.files`).
   * Forces fail-closed escalation to `hardware-isolated`.
   */
  partialFileList?: boolean;
  /** Explicit override; also read from operator env `QWEN_REVIEW_FORCE_HARDWARE`. */
  forceHardware?: boolean;
}

export interface ReviewTrustClassification {
  prTrust: ReviewPrTrust;
  executionClass: ReviewExecutionClass;
  escalationReasons: string[];
  /**
   * Non-empty when an operator opt-in downgraded an otherwise-escalated
   * external PR to the shared-kernel tier because every changed path is
   * provably non-executable content. Disclosed, never silent.
   */
  downgradeReasons?: string[];
}

export interface ReviewExecutionBoundary {
  policy: 'off' | 'auto' | 'required' | 'tiered';
  prTrust: ReviewPrTrust;
  executionClass: ReviewBoundaryExecutionClass;
  backend: ReviewSandboxBackend;
  escalationReasons: string[];
  downgradeReasons?: string[];
  teardownStatus?: ReviewTeardownStatus;
  note?: string;
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const EXTERNAL_ASSOCIATIONS = new Set([
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  'MANNEQUIN',
]);
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

const ESCALATION_RULES: ReadonlyArray<{
  reason: string;
  matches: (normalizedPath: string) => boolean;
}> = [
  {
    reason: 'dependency-manifest',
    matches: (p) =>
      /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.ya?ml)?|\.pnpmfile\.mjs|pom\.xml|mvnw(?:\.cmd)?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|requirements[^/]*\.txt|setup\.py|Gemfile(?:\.lock)?|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradlew(?:\.bat)?)$/i.test(
        p,
      ) || /(?:^|\/)(?:patches|\.mvn)\//i.test(p),
  },
  {
    reason: 'ci-or-agent-config',
    matches: (p) =>
      /(?:^|\/)(?:\.github\/(?:workflows|actions)\/|\.husky\/|\.qwen\/|\.claude\/)/i.test(
        p,
      ) || /(?:^|\/)(?:\.gitmodules|\.gitattributes)$/i.test(p),
  },
  {
    reason: 'build-or-sandbox-tooling',
    matches: (p) =>
      /(?:^|\/)scripts\//i.test(p) ||
      /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|docker-compose[^/]*\.ya?ml|(?:GNU)?Makefile|[^/]+\.mk|justfile|Taskfile\.ya?ml|turbo\.json|build\.[cm]?[jt]s|(?:esbuild|vite|vitest|babel|webpack|rollup|jest|playwright|postcss|tailwind|next|prettier|eslint)\.config\.[^/]+|tsconfig[^/]*\.json|\.eslintrc(?:\.[^/]+)?|\.prettierrc\.(?:js|cjs|mjs))$/i.test(
        p,
      ),
  },
  {
    reason: 'executable-extension',
    matches: (p) =>
      /\.(?:sh|bash|zsh|py|rb|pl|ps1|bat|cmd|exe|dll|so|dylib)$/i.test(p),
  },
];

function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/|\/)+/, '');
}

function hasPathTraversalSegment(normalizedPath: string): boolean {
  return normalizedPath.split('/').some((seg) => seg === '..');
}

/**
 * Operator emergency switch that forces `hardware-isolated` regardless of PR
 * trust or policy. File-sourced values from repository `.env` files are ignored.
 */
export function forceHardwareRequested(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): boolean {
  if (fileSourced('QWEN_REVIEW_FORCE_HARDWARE')) return false;
  const raw = env['QWEN_REVIEW_FORCE_HARDWARE']?.trim().toLowerCase();
  return Boolean(raw && TRUTHY_ENV_VALUES.has(raw));
}

const CONTENT_ALLOWLIST_ROOT_FILES = new Set([
  'readme.md',
  'changelog.md',
  'contributing.md',
  'license.md',
]);

/**
 * Narrow content allowlist for the operator opt-in that lets an external PR
 * run in the hardened shared-kernel container: only Markdown under `docs/`
 * and the four root prose files. Deliberately excludes data formats that a
 * toolchain might parse or execute (json/yaml/svg/images) and anything with
 * an executable or special git mode.
 */
export function isReviewContentAllowlistedPath(rawPath: string): boolean {
  const p = normalizePath(rawPath).toLowerCase();
  if (!p || hasPathTraversalSegment(p)) return false;
  if (p.startsWith('docs/') && p.endsWith('.md')) return true;
  return !p.includes('/') && CONTENT_ALLOWLIST_ROOT_FILES.has(p);
}

/**
 * Operator opt-in (default off) permitting the external content-allowlist
 * downgrade. File-sourced values from repository `.env` files are ignored so
 * a reviewed repo cannot grant itself the shared-kernel tier.
 */
export function externalContentContainerRequested(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): boolean {
  if (fileSourced('QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER')) return false;
  const raw = env['QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER']
    ?.trim()
    .toLowerCase();
  return Boolean(raw && TRUTHY_ENV_VALUES.has(raw));
}

/**
 * Detects mandatory escalation triggers across changed files (aligned with
 * `/verify-pr` tiered microVM classification). Checks both `path` and
 * `renameFrom` so renames cannot bypass escalation.
 */
export function detectReviewMandatoryEscalations(
  files: readonly ReviewChangedFile[],
): string[] {
  const reasons = new Set<string>();
  for (const file of files) {
    if (file.mode === '100755') {
      reasons.add(`executable-mode:${normalizePath(file.path)}`);
    } else if (file.mode === '120000') {
      reasons.add(`symlink-entry:${normalizePath(file.path)}`);
    } else if (file.mode === '160000') {
      reasons.add(`submodule-entry:${normalizePath(file.path)}`);
    }
    if (file.binary) {
      reasons.add(`binary-file:${normalizePath(file.path)}`);
    }
    const candidates = file.renameFrom
      ? [file.path, file.renameFrom]
      : [file.path];
    for (const rawPath of candidates) {
      const normalized = normalizePath(rawPath);
      if (!normalized) continue;
      if (hasPathTraversalSegment(normalized)) {
        reasons.add(`suspicious-path-traversal:${normalized}`);
      }
      for (const rule of ESCALATION_RULES) {
        if (rule.matches(normalized)) {
          reasons.add(`${rule.reason}:${normalized}`);
        }
      }
    }
  }
  return [...reasons].sort();
}

/**
 * Classifies a `/review` execution into `prTrust` and `executionClass`.
 *
 * Fail-closed by construction: any external/fork PR, unknown association,
 * missing changed-file list on a PR, mandatory high-risk path hit, or operator
 * force switch resolves to `hardware-isolated`.
 */
export function classifyReviewTrust(
  input: ReviewTrustInput = {},
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): ReviewTrustClassification {
  const escalationReasons: string[] = [];
  const forceHardware =
    input.forceHardware === true || forceHardwareRequested(env, fileSourced);

  let prTrust: ReviewPrTrust;
  if (input.isLocal === true) {
    prTrust = 'local-owner';
  } else if (input.isCrossRepository === true) {
    prTrust = 'external';
  } else {
    const assoc = input.authorAssociation?.trim().toUpperCase();
    if (
      input.isCrossRepository === false &&
      assoc &&
      TRUSTED_ASSOCIATIONS.has(assoc)
    ) {
      prTrust = 'collaborator';
    } else if (assoc && EXTERNAL_ASSOCIATIONS.has(assoc)) {
      prTrust = 'external';
    } else {
      prTrust = 'unknown';
    }
  }

  if (forceHardware) {
    escalationReasons.push('operator-force-hardware');
  }
  if (prTrust === 'external') {
    escalationReasons.push(
      input.isCrossRepository === true
        ? 'cross-repository-pr'
        : 'external-author',
    );
  } else if (prTrust === 'unknown') {
    escalationReasons.push('unknown-pr-trust');
  }

  if (input.partialFileList === true) {
    escalationReasons.push('changed-files-incomplete');
  }

  if (input.changedFiles === undefined) {
    if (!input.isLocal) {
      escalationReasons.push('changed-files-unavailable');
    }
  } else {
    escalationReasons.push(
      ...detectReviewMandatoryEscalations(input.changedFiles),
    );
  }

  // Operator opt-in downgrade: an external PR whose complete diff touches
  // only provably non-executable content may use the hardened shared-kernel
  // container. Any mandatory escalation that still fires (e.g. a `scripts/`
  // segment inside an allowlisted directory) keeps the PR hardware-isolated
  // and suppresses the downgrade disclosure; the downgrade removes only the
  // author-identity escalation and is disclosed separately.
  const downgradeReasons: string[] = [];
  if (
    prTrust === 'external' &&
    !forceHardware &&
    input.partialFileList !== true &&
    input.changedFiles !== undefined &&
    externalContentContainerRequested(env, fileSourced) &&
    detectReviewMandatoryEscalations(input.changedFiles).length === 0 &&
    input.changedFiles.every(
      (f) => !f.renameFrom && isReviewContentAllowlistedPath(f.path),
    )
  ) {
    for (const reason of ['cross-repository-pr', 'external-author']) {
      const idx = escalationReasons.indexOf(reason);
      if (idx >= 0) escalationReasons.splice(idx, 1);
    }
    downgradeReasons.push('external-content-allowlist');
  }

  const executionClass: ReviewExecutionClass =
    escalationReasons.length > 0
      ? 'hardware-isolated'
      : 'trusted-shared-kernel';

  return {
    prTrust,
    executionClass,
    escalationReasons: [...new Set(escalationReasons)],
    ...(downgradeReasons.length > 0 ? { downgradeReasons } : {}),
  };
}

interface PlanTrustShape {
  prNumber?: unknown;
  ownerRepo?: unknown;
  headRefName?: unknown;
  isCrossRepository?: unknown;
  authorAssociation?: unknown;
  diffPath?: unknown;
  collapsedFromUpstream?: unknown;
  baseFetchFailed?: unknown;
  incremental?: unknown;
  diffStat?: {
    files?: unknown;
  };
  files?: Array<{
    path?: unknown;
    renameFrom?: unknown;
    mode?: unknown;
    binary?: unknown;
  }>;
}

/**
 * Extracts `ReviewTrustInput` from a `fetch-pr` or `capture-local` plan file.
 * Returns fail-closed `{ isLocal: false }` if the file cannot be read, parsed,
 * or lacks a valid plan shape.
 */
export function trustInputFromPlan(planPath: string): ReviewTrustInput {
  try {
    const parsed: unknown = JSON.parse(readFileSync(planPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { isLocal: false };
    }
    const raw = parsed as PlanTrustShape;
    const hasPrNumber =
      (typeof raw.prNumber === 'string' && raw.prNumber.trim().length > 0) ||
      (typeof raw.prNumber === 'number' &&
        Number.isSafeInteger(raw.prNumber) &&
        raw.prNumber > 0);
    const isPr =
      hasPrNumber ||
      raw.isCrossRepository !== undefined ||
      raw.authorAssociation !== undefined ||
      raw.ownerRepo !== undefined ||
      raw.headRefName !== undefined;
    const changedFiles: ReviewChangedFile[] | undefined = Array.isArray(
      raw.files,
    )
      ? raw.files
          .filter(
            (
              f,
            ): f is {
              path: string;
              renameFrom?: unknown;
              mode?: unknown;
              binary?: unknown;
            } => typeof f?.path === 'string' && f.path.length > 0,
          )
          .map((f) => ({
            path: f.path,
            ...(typeof f.renameFrom === 'string' && f.renameFrom.length > 0
              ? { renameFrom: f.renameFrom }
              : {}),
            ...(typeof f.mode === 'string' && f.mode.trim().length > 0
              ? { mode: f.mode.trim() }
              : {}),
            ...(typeof f.binary === 'boolean' ? { binary: f.binary } : {}),
          }))
      : undefined;

    const hasMalformedFileEntry =
      Array.isArray(raw.files) &&
      changedFiles !== undefined &&
      changedFiles.length !== raw.files.length;

    if (!isPr) {
      if (changedFiles === undefined || hasMalformedFileEntry) {
        return {
          isLocal: false,
          ...(hasMalformedFileEntry ? { partialFileList: true } : {}),
        };
      }
      return {
        isLocal: true,
        changedFiles,
      };
    }

    const incrementalNarrowed =
      raw.incremental !== undefined &&
      raw.incremental !== null &&
      (typeof raw.incremental !== 'object' ||
        (raw.incremental as { effective?: unknown }).effective !== false);
    const advertisedFiles =
      raw.diffStat &&
      typeof raw.diffStat === 'object' &&
      typeof raw.diffStat.files === 'number' &&
      Number.isFinite(raw.diffStat.files) &&
      raw.diffStat.files >= 0
        ? raw.diffStat.files
        : undefined;
    const diffMissing =
      raw.diffPath === null &&
      (advertisedFiles === undefined || advertisedFiles > 0);
    const partialFileList =
      hasMalformedFileEntry ||
      incrementalNarrowed ||
      diffMissing ||
      raw.collapsedFromUpstream === true ||
      raw.baseFetchFailed === true ||
      (advertisedFiles !== undefined &&
        changedFiles !== undefined &&
        changedFiles.length !== advertisedFiles);

    return {
      isLocal: false,
      ...(typeof raw.isCrossRepository === 'boolean'
        ? { isCrossRepository: raw.isCrossRepository }
        : {}),
      ...(typeof raw.authorAssociation === 'string' &&
      raw.authorAssociation.trim().length > 0
        ? { authorAssociation: raw.authorAssociation.trim() }
        : {}),
      ...(changedFiles !== undefined ? { changedFiles } : {}),
      ...(partialFileList ? { partialFileList: true } : {}),
    };
  } catch {
    return { isLocal: false };
  }
}
