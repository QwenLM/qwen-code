/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review publish-assets`: host evidence images for a PR review in the
// user-designated assets repository, and hand back commit-pinned URLs.
//
// GitHub's API cannot attach images to review comments — the web UI's
// drag-and-drop upload has no API equivalent — so image evidence must be hosted
// somewhere durable and referenced by URL. This command is the ONLY sanctioned
// way a review gets it there, and it inherits the shape of the skill's other
// public write (`submit`) deliberately:
//
//   - **Designated destination.** It writes only to `QWEN_REVIEW_ASSETS_REPO`,
//     an owner/repo the user set by hand — never to a repo the model chose. No
//     designation, no publish, exit 3. (A separate variable from
//     `QWEN_REVIEW_SCRATCH_REPO` on purpose: the scratch repo's contract
//     forbids PR-derived content, and evidence screenshots are exactly that.)
//   - **Authorised run.** It publishes only when the run is authorised to post
//     the review itself — the same args-file re-parse and target binding as
//     `submit`, from the same shared gate. A terminal-only review has no
//     business pushing the PR's behaviour to a public branch.
//   - **Auditable.** It writes a manifest naming every file it pushed and the
//     commit they landed on, next to the other review artifacts, where
//     `cleanup`'s sweep and a curious human can find it.
//
// Mechanics: files land on branch `pr-assets/<pr>-review` of the assets repo
// via the Contents API (no local clone, no SSH — the manual flow this feature
// grew from measured SSH pushes failing where HTTPS worked, and `gh api` IS
// HTTPS with gh's own auth). URLs are pinned to the final commit SHA, so a
// posted comment's evidence is immutable even if the branch later moves.

import type { CommandModule } from 'yargs';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { gh, ghWithInput, setGhHost } from './lib/gh.js';
import { reviewWriteAuthorization } from './lib/authorization.js';
import {
  MAX_TOTAL_ASSET_BYTES,
  assetsBranch,
  parseAssetsRepo,
  rawAssetUrl,
  remoteAssetPath,
  validateAssetFile,
  type AssetsManifest,
  type PublishedAsset,
} from './lib/assets.js';
import { validateFindings, buildReport, type Finding } from './findings.js';

interface PublishAssetsArgs {
  pr: number;
  files: string[] | undefined;
  findings: string | undefined;
  findingsOut: string | undefined;
  out: string;
  host: string | undefined;
  userAuthorized: boolean;
  skillArgs: string | undefined;
}

/** The Contents-API dance for one file: create, or update when it exists. */
function putContent(
  repo: string,
  branch: string,
  remotePath: string,
  contentBase64: string,
  pr: number,
): string {
  const api = `repos/${repo}/contents/${remotePath}`;
  const message = `review evidence for PR #${pr}`;
  const payload = (sha?: string) =>
    JSON.stringify({
      message,
      content: contentBase64,
      branch,
      ...(sha ? { sha } : {}),
    });
  try {
    const created = ghWithInput(
      payload(),
      'api',
      '-X',
      'PUT',
      api,
      '--input',
      '-',
    );
    return JSON.parse(created).commit.sha as string;
  } catch {
    // The path already exists on the branch (identical content hashes to the
    // same remote path, so this is the idempotent re-run case). Updating needs
    // the blob's current sha.
    const existing = gh(
      'api',
      `${api}?ref=${encodeURIComponent(branch)}`,
      '--jq',
      '.sha',
    );
    const updated = ghWithInput(
      payload(existing.trim()),
      'api',
      '-X',
      'PUT',
      api,
      '--input',
      '-',
    );
    return JSON.parse(updated).commit.sha as string;
  }
}

/** Ensure the assets branch exists; create it from the default branch if not. */
function ensureBranch(repo: string, branch: string): void {
  try {
    gh('api', `repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
    return;
  } catch {
    // Missing — create from the default branch head.
  }
  const defaultBranch = gh('api', `repos/${repo}`, '--jq', '.default_branch');
  const baseSha = gh(
    'api',
    `repos/${repo}/git/ref/${encodeURIComponent(`heads/${defaultBranch.trim()}`)}`,
    '--jq',
    '.object.sha',
  );
  ghWithInput(
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha.trim() }),
    'api',
    '-X',
    'POST',
    `repos/${repo}/git/refs`,
    '--input',
    '-',
  );
}

export function runPublishAssets(args: PublishAssetsArgs): void {
  // ── Gate 1: a designated destination ──────────────────────────────────────
  const repoResult = parseAssetsRepo(process.env['QWEN_REVIEW_ASSETS_REPO']);
  if ('error' in repoResult) {
    writeStderrLine(repoResult.error);
    writeStdoutLine(JSON.stringify({ published: false }));
    process.exitCode = 3;
    return;
  }
  const repo = repoResult.repo;

  // ── Gate 2: an authorised run — the same gate as `submit` ─────────────────
  // The PR identity used for authorisation binding is the PR the evidence is
  // FOR (the one under review), regardless of which repo hosts the images.
  const auth = reviewWriteAuthorization({
    userAuthorized: args.userAuthorized,
    skillArgs: args.skillArgs,
    pr: args.pr,
    // Target binding for url-shaped authorisations compares against the repo
    // being written; for assets that is the designated repo only when it IS
    // the reviewed repo. A `--comment` on a bare PR number authorises by
    // number alone, which is the common case. URL-shaped args bind to the
    // reviewed repo, so pass that binding through unchanged via the assets
    // repo when they match, and let a mismatch surface as a refusal the user
    // can read rather than a silent publish.
    repo,
    host: args.host,
  });
  if (!auth.ok) {
    writeStderrLine(
      `publish-assets: not authorised — ${auth.why}. Evidence images are ` +
        'published only for a run that is authorised to post the review ' +
        'itself; the findings and their local file paths remain in the ' +
        'terminal output and the saved report.',
    );
    writeStdoutLine(JSON.stringify({ published: false }));
    process.exitCode = 3;
    return;
  }

  if (args.host) setGhHost(args.host);

  // ── Collect the files: --files, or every assetFiles in the artifact ───────
  let findings: Finding[] | undefined;
  const fileList: string[] = [...(args.files ?? [])];
  if (args.findings) {
    const artifact = JSON.parse(readFileSync(resolve(args.findings), 'utf8'));
    // Accept either the raw findings array or the canonical report shape.
    findings = validateFindings(
      Array.isArray(artifact) ? artifact : artifact.findings,
    );
    for (const f of findings) {
      for (const a of f.assetFiles ?? []) fileList.push(a);
    }
  }
  const unique = [...new Set(fileList)];
  if (unique.length === 0) {
    writeStderrLine('publish-assets: no files to publish.');
    writeStdoutLine(JSON.stringify({ published: false }));
    process.exitCode = 3;
    return;
  }

  // ── Validate before any write: one bad file refuses the batch ─────────────
  // All-or-nothing on purpose, mirroring the Create-Review API's own shape: a
  // partially published evidence set is harder to reason about than a refused
  // one, and the caller can drop the offending file and re-run (idempotent by
  // content hash).
  interface Prepared {
    file: string;
    name: string;
    bytes: number;
    sha256: string;
    remotePath: string;
    contentBase64: string;
  }
  const prepared: Prepared[] = [];
  let total = 0;
  for (const file of unique) {
    const abs = resolve(file);
    let bytes: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new Error('not a regular file');
      bytes = st.size;
    } catch (err) {
      throw new Error(
        `publish-assets: cannot read ${JSON.stringify(file)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const name = basename(abs);
    const verdict = validateAssetFile(name, bytes);
    if (!verdict.ok) {
      throw new Error(`publish-assets: refused — ${verdict.reason}`);
    }
    total += bytes;
    if (total > MAX_TOTAL_ASSET_BYTES) {
      throw new Error(
        `publish-assets: refused — total size exceeds ${MAX_TOTAL_ASSET_BYTES} bytes`,
      );
    }
    const content = readFileSync(abs);
    const sha256 = createHash('sha256').update(content).digest('hex');
    prepared.push({
      file,
      name,
      bytes,
      sha256,
      remotePath: remoteAssetPath(args.pr, name, sha256),
      contentBase64: content.toString('base64'),
    });
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  const branch = assetsBranch(args.pr);
  ensureBranch(repo, branch);
  let headSha = '';
  for (const p of prepared) {
    headSha = putContent(repo, branch, p.remotePath, p.contentBase64, args.pr);
  }

  const published: PublishedAsset[] = prepared.map((p) => ({
    file: p.file,
    remotePath: p.remotePath,
    url: rawAssetUrl({
      host: args.host,
      repo,
      commitSha: headSha,
      remotePath: p.remotePath,
    }),
    bytes: p.bytes,
    sha256: p.sha256,
  }));

  const manifest: AssetsManifest = {
    repo,
    branch,
    commitSha: headSha,
    pr: args.pr,
    published,
  };
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // ── Pipeline mode: write the URLs back into the findings artifact ─────────
  if (findings && args.findingsOut) {
    const urlByFile = new Map(published.map((p) => [p.file, p.url]));
    const updated = findings.map((f) => {
      const urls = (f.assetFiles ?? [])
        .map((a) => urlByFile.get(a))
        .filter((u): u is string => u !== undefined);
      return urls.length > 0 ? { ...f, assets: urls } : f;
    });
    const report = buildReport(updated);
    const fOut = resolve(args.findingsOut);
    mkdirSync(dirname(fOut), { recursive: true });
    writeFileSync(fOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  writeStderrLine(
    `publish-assets: ${published.length} file(s) → ${repo}@${branch} ` +
      `(commit ${headSha.slice(0, 9)})`,
  );
  writeStdoutLine(JSON.stringify({ published: true, count: published.length }));
}

export const publishAssetsCommand: CommandModule = {
  command: 'publish-assets',
  describe:
    'Publish review evidence images to the user-designated assets repository (QWEN_REVIEW_ASSETS_REPO) and emit commit-pinned URLs — gated on the same authorisation as submit',
  builder: (yargs) =>
    yargs
      .option('pr', {
        type: 'number',
        demandOption: true,
        describe: 'The pull request this evidence belongs to',
      })
      .option('files', {
        type: 'string',
        array: true,
        describe: 'Evidence image files to publish',
      })
      .option('findings', {
        type: 'string',
        describe:
          'Findings artifact whose per-finding assetFiles should be published',
      })
      .option('findings-out', {
        type: 'string',
        describe:
          'Where to write the findings artifact with published URLs woven into each finding (requires --findings)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the publish manifest',
      })
      .option('host', {
        type: 'string',
        describe: 'GitHub Enterprise host (defaults to github.com)',
      })
      .option('user-authorized', {
        type: 'boolean',
        default: false,
        describe:
          'Pass ONLY when the user asked, in a message they typed this session, for this review to be published',
      })
      .option('skill-args', {
        type: 'string',
        describe:
          'Test seam: path to the recorded review arguments (ignored when a session id is present)',
      }),
  handler: (argv) => {
    runPublishAssets({
      pr: argv['pr'] as number,
      files: argv['files'] as string[] | undefined,
      findings: argv['findings'] as string | undefined,
      findingsOut: argv['findings-out'] as string | undefined,
      out: argv['out'] as string,
      host: argv['host'] as string | undefined,
      userAuthorized: Boolean(argv['user-authorized']),
      skillArgs: argv['skill-args'] as string | undefined,
    });
  },
};
