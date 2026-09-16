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
import { gh, ghWithInputRetried, resolveGhHost, setGhHost } from './lib/gh.js';
import { reviewWriteAuthorization } from './lib/authorization.js';
import { operatorReviewSettings } from './lib/review-settings.js';
import {
  ASSET_HEADER_BYTES,
  assetsBranch,
  parseAssetsRepo,
  rawAssetUrl,
  remoteAssetPath,
  validateAssetBatch,
  validateAssetContent,
  type AssetsManifest,
  type PublishedAsset,
} from './lib/assets.js';
import { validateFindings, buildReport, type Finding } from './findings.js';

interface PublishAssetsArgs {
  pr: number;
  reviewedRepo: string | undefined;
  files: string[] | undefined;
  findings: string | undefined;
  findingsOut: string | undefined;
  out: string;
  host: string | undefined;
  userAuthorized: boolean;
  skillArgs: string | undefined;
  /** The standing `review.comment` setting, for the shared authorisation gate. */
  defaultComment?: boolean;
}

interface GhRepoView {
  owner?: { login?: string };
  name?: string;
  parent?: {
    owner?: { login?: string };
    name?: string;
  };
}

function resolveReviewedRepoForSelfTargetWarning(
  args: PublishAssetsArgs,
): string | undefined {
  if (args.reviewedRepo !== undefined) {
    return args.reviewedRepo;
  }
  try {
    const view = JSON.parse(
      gh('repo', 'view', '--json', 'owner,name,url,parent'),
    ) as GhRepoView;
    const target = view.parent ?? view;
    const owner = target.owner?.login;
    const name = target.name;
    return owner && name ? `${owner}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

function warnIfAssetsRepoTargetsReviewedRepo(
  assetsRepo: string,
  args: PublishAssetsArgs,
): void {
  const reviewedRepo = resolveReviewedRepoForSelfTargetWarning(args);
  if (reviewedRepo?.toLowerCase() !== assetsRepo.toLowerCase()) return;
  writeStderrLine(
    'publish-assets: warning — QWEN_REVIEW_ASSETS_REPO points at the reviewed ' +
      'repository. Evidence images will still be published because the ' +
      'destination was explicitly designated, but this recreates pr-assets/* refs ' +
      'in the repository under review.',
  );
}

/** The Contents-API dance for one file: create, or update when it exists. */
function putContent(
  repo: string,
  branch: string,
  remotePath: string,
  contentBase64: string,
  pr: number,
): void {
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
    ghWithInputRetried(payload(), 'api', '-X', 'PUT', api, '--input', '-');
  } catch (err) {
    // Retry ONLY the already-exists shape (a 422 asking for the blob sha —
    // the idempotent re-run case, since identical content hashes to the same
    // remote path). Anything else — auth, network, a 404 on the repo — is
    // rethrown as itself: a catch-all retry here would answer a 401 with a
    // second failure from the sha lookup, burying the error the user needs.
    //
    // Anchored `HTTP 422`, never a bare `422`: execFileSync embeds the whole
    // command line in err.message, and the API path bakes in the PR number —
    // publishing evidence for PR #422 (or #4220) would otherwise read every
    // failure, 401 included, as "already exists". Caught by this skill's own
    // review.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/HTTP 422|"sha"|sha wasn't supplied|already exists/i.test(msg)) {
      throw err;
    }
    let existing: string;
    try {
      existing = gh(
        'api',
        `${api}?ref=${encodeURIComponent(branch)}`,
        '--jq',
        '.sha',
      ).trim();
    } catch {
      // The retry premise was wrong (the 422 was not the sha-missing shape —
      // branch protection, say — and the path does not exist): the GET's 404
      // must not replace the PUT error the user actually needs.
      throw err;
    }
    if (existing === '' || existing === 'null') {
      // The path is claimed to exist yet has no blob sha to update against —
      // whatever is going on, a PUT with sha:"null" would only bury the
      // original error under a second 422. Surface the first failure.
      throw err;
    }
    ghWithInputRetried(
      payload(existing),
      'api',
      '-X',
      'PUT',
      api,
      '--input',
      '-',
    );
  }
}

/** Ensure the assets branch exists; create it from the default branch if not. */
function ensureBranch(repo: string, branch: string): void {
  // Ref paths keep their slashes LITERAL — that is the form GitHub's own docs
  // use for slash-named refs, and %2F-encoding them routes inconsistently
  // across endpoints (a 404 here would read as "branch missing" and send the
  // create call into a 422 on every re-run). The branch name is built from a
  // validated integer and fixed strings, so literal interpolation is safe; the
  // contents `?ref=` QUERY VALUE below is a different position and keeps its
  // encoding.
  try {
    gh('api', `repos/${repo}/git/ref/heads/${branch}`);
    return;
  } catch (err) {
    // Only a 404 means "branch missing". A 401/403/exhausted-5xx caught here
    // would send the create call at a branch that exists and bury the real
    // error under its 422 — the exact catch-all-shape putContent's comment
    // warns against.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/HTTP 404|Not Found/i.test(msg)) throw err;
  }
  const defaultBranch = gh('api', `repos/${repo}`, '--jq', '.default_branch');
  let baseSha: string;
  // (validated non-empty below — a jq miss must not POST sha:"")
  try {
    baseSha = gh(
      'api',
      `repos/${repo}/git/ref/heads/${defaultBranch.trim()}`,
      '--jq',
      '.object.sha',
    );
  } catch (err) {
    // GitHub reports a default_branch even for an EMPTY repo, so the failure
    // lands here — as a bare 404 that reads like the branch-missing case.
    // Name the actual condition and what fixes it.
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|Not Found/i.test(msg)) {
      throw new Error(
        `assets repository ${repo} appears to be empty (its default branch ` +
          `${defaultBranch.trim()} has no commits). Push an initial commit to ` +
          'it once; publish-assets creates and reuses its own branch from there.',
      );
    }
    throw err;
  }
  const base = baseSha.trim();
  if (base === '' || base === 'null') {
    throw new Error(
      `could not resolve the head of ${repo}@${defaultBranch.trim()} — the ` +
        'ref lookup returned nothing to branch from.',
    );
  }
  try {
    ghWithInputRetried(
      JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }),
      'api',
      '-X',
      'POST',
      `repos/${repo}/git/refs`,
      '--input',
      '-',
    );
  } catch (err) {
    // A retried create can double-fire after a proxy 502 that GitHub in fact
    // processed; the duplicate answers "Reference already exists", and an
    // existing branch is this function's goal, not a failure. ONLY that
    // message — a broad HTTP 422 here would also swallow "Object does not
    // exist" (a bad sha), leaving every later PUT to fail against a branch
    // that was never created, far from the cause.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
  }
}

export function runPublishAssets(args: PublishAssetsArgs): void {
  // Every refusal in this command speaks one language: a stderr line naming
  // the reason, `{"published": false}` on stdout, exit 3. One helper, used by
  // every gate — seven inline copies of the same three lines is how one site
  // eventually forgets the exit code.
  const refuse = (reason: string): void => {
    writeStderrLine(`publish-assets: refused — ${reason}`);
    writeStdoutLine(JSON.stringify({ published: false }));
    process.exitCode = 3;
  };

  // ── Gate 0: a PR identity that can name a branch ──────────────────────────
  // yargs `type: 'number'` happily passes NaN, 0, -1 and 3.5 through, and with
  // `--user-authorized` the authorization gate never re-parses the target — so
  // without this check a `--pr abc` run creates branch `pr-assets/NaN-review`.
  // Sibling discipline: `submit` guards the identical input the same way.
  if (!Number.isInteger(args.pr) || args.pr <= 0) {
    refuse(`--pr must be a positive integer, got ${String(args.pr)}.`);
    return;
  }

  // ── Gate 1: a designated destination ──────────────────────────────────────
  const repoResult = parseAssetsRepo(process.env['QWEN_REVIEW_ASSETS_REPO']);
  if ('error' in repoResult) {
    refuse(repoResult.error);
    return;
  }
  const repo = repoResult.repo;

  // ONE effective host, resolved BEFORE the gate: the gate must bind the
  // host the write will actually route at, not merely the flag. Binding
  // args.host while routing at effectiveHost let a GH_HOST-driven Enterprise
  // write pass a github.com authorisation; caught by this skill's own review.
  //
  // Validate the RAW flag first: a non-empty all-whitespace `--host` must
  // throw setGhHost's documented TypeError here (it resolves to '' / falsy,
  // which would skip the routing setGhHost below and silently retarget the
  // Contents-API write at the env/default host). `setGhHost('')` legitimately
  // resets; `setGhHost(' ')` throws — so guard on presence, not on trim-non-empty.
  if (args.host !== undefined) {
    try {
      setGhHost(args.host);
    } catch (err) {
      refuse(
        `${err instanceof Error ? err.message : String(err)} (from --host)`,
      );
      return;
    }
    setGhHost(undefined); // restore default; effectiveHost routing re-applies
  }
  const effectiveHost = resolveGhHost(args.host);

  // ── Gate 2: an authorised run — the same gate as `submit` ─────────────────
  // The PR identity used for authorisation binding is the PR the evidence is
  // FOR (the one under review), regardless of which repo hosts the images.
  const auth = reviewWriteAuthorization({
    userAuthorized: args.userAuthorized,
    defaultComment: args.defaultComment,
    skillArgs: args.skillArgs,
    pr: args.pr,
    // Bind the REVIEWED repo when the caller names it, never the assets repo:
    // the designation itself is the consent for the destination, and binding a
    // URL-shaped authorisation against a fork-hosted assets repo refused
    // legitimately authorised runs. Without --reviewed-repo the gate binds the
    // PR number (and host) alone.
    repo: args.reviewedRepo,
    host: effectiveHost,
  });
  if (!auth.ok) {
    refuse(
      `not authorised — ${auth.why}. Evidence images are published only for ` +
        'a run that is authorised to post the review itself; the findings ' +
        'and their local file paths remain in the terminal output and the ' +
        'saved report.',
    );
    return;
  }

  // …and the same effectiveHost routes the gh calls and names the URLs.
  if (effectiveHost) {
    try {
      setGhHost(effectiveHost);
    } catch (err) {
      // setGhHost validates the hostname and throws on garbage. From the
      // --host flag that is the caller's own typo; from an operator-exported
      // GH_HOST it would be an uncaught TypeError with a stack trace for an
      // input this command chose to read. Same answer either way, in the
      // refusal language: name the value and where it came from.
      refuse(
        `${err instanceof Error ? err.message : String(err)} (from ${
          args.host !== undefined
            ? '--host'
            : 'the GH_HOST environment variable'
        })`,
      );
      return;
    }
  }

  // ── Collect the files: --files, or every assetFiles in the artifact ───────
  let findings: Finding[] | undefined;
  const fileList: string[] = [...(args.files ?? [])];
  if (args.findings) {
    // The same refusal contract as every other malformed input in this
    // command — an unreadable or invalid artifact must not surface as a yargs
    // stack trace two screens after this file established exit-3 +
    // {"published": false} as the refusal language.
    try {
      const artifact = JSON.parse(readFileSync(resolve(args.findings), 'utf8'));
      // Accept either the raw findings array or the canonical report shape.
      findings = validateFindings(
        Array.isArray(artifact) ? artifact : artifact.findings,
      );
    } catch (err) {
      refuse(
        `cannot use the findings artifact at ${JSON.stringify(args.findings)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    for (const f of findings) {
      for (const a of f.assetFiles ?? []) fileList.push(a);
    }
  }
  const unique = [...new Set(fileList)];
  if (unique.length === 0) {
    // Two different empties. `--files` with nothing named is a caller error —
    // refuse (exit 3) so a wired-up pipeline notices. `--findings` whose
    // artifact simply carries no evidence is the ORDINARY case for most
    // reviews — a no-op, exit 0, so an orchestrator may call this
    // unconditionally on every posting run without manufacturing a failure to
    // repair.
    if (args.findings) {
      writeStderrLine(
        'publish-assets: no finding carries assetFiles — nothing to publish.',
      );
      writeStdoutLine(JSON.stringify({ published: false, count: 0 }));
      return;
    }
    refuse('no files to publish.');
    return;
  }

  // ── Validate before any write: one bad file refuses the batch ─────────────
  // All-or-nothing on purpose, mirroring the Create-Review API's own shape: a
  // partially published evidence set is harder to reason about than a refused
  // one, and the caller can drop the offending file and re-run (idempotent by
  // content hash).
  interface Prepared {
    file: string;
    bytes: number;
    sha256: string;
    remotePath: string;
    contentBase64: string;
  }
  interface Stat {
    file: string;
    abs: string;
    basename: string;
    bytes: number;
  }
  const stats: Stat[] = [];
  for (const file of unique) {
    const abs = resolve(file);
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new Error('not a regular file');
      stats.push({ file, abs, basename: basename(abs), bytes: st.size });
    } catch (err) {
      refuse(
        `cannot read ${JSON.stringify(file)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
  }
  // Per-file rules and the aggregate cap live in one pure ruling
  // (validateAssetBatch), so the 40MB total is unit-tested without fixtures.
  const batch = validateAssetBatch(stats);
  if (!batch.ok) {
    refuse(batch.reason);
    return;
  }
  const prepared: Prepared[] = [];
  for (const st of stats) {
    let content: Buffer;
    try {
      content = readFileSync(st.abs);
    } catch (err) {
      // stat succeeded moments ago; a file vanishing between the two is the
      // same refusal as one that never existed.
      refuse(
        `cannot read ${JSON.stringify(st.file)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    // The batch ruling above admitted the file by name and size; this one
    // admits it by CONTENT — an extension is a claim anyone can make, and
    // the allowlist is only as strong as the bytes behind it.
    const contentRuling = validateAssetContent(
      st.basename,
      content.subarray(0, ASSET_HEADER_BYTES),
    );
    if (!contentRuling.ok) {
      refuse(`${JSON.stringify(st.file)}: ${contentRuling.reason}`);
      return;
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    prepared.push({
      file: st.file,
      bytes: st.bytes,
      sha256,
      remotePath: remoteAssetPath(args.pr, st.basename, sha256),
      contentBase64: content.toString('base64'),
    });
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  const branch = assetsBranch(args.pr);
  ensureBranch(repo, branch);
  for (const p of prepared) {
    putContent(repo, branch, p.remotePath, p.contentBase64, args.pr);
  }
  // Pin URLs to the branch head read AFTER the uploads — never to a PUT
  // response's `commit` field, whose shape on an identical-content update is
  // GitHub's to decide, not ours to assume. One extra call buys independence
  // from that assumption, and every uploaded file exists at this head because
  // the uploads are sequential commits on one branch.
  const headSha = gh(
    'api',
    `repos/${repo}/git/ref/heads/${branch}`,
    '--jq',
    '.object.sha',
  ).trim();

  const published: PublishedAsset[] = prepared.map((p) => ({
    file: p.file,
    remotePath: p.remotePath,
    url: rawAssetUrl({
      host: effectiveHost,
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
  warnIfAssetsRepoTargetsReviewedRepo(repo, args);

  // ── Pipeline mode: write the URLs back into the findings artifact ─────────
  if (findings && !args.findingsOut) {
    writeStderrLine(
      'publish-assets: --findings given without --findings-out — the URLs are ' +
        'in the manifest only; the artifact keeps local paths.',
    );
  }
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
      .option('reviewed-repo', {
        type: 'string',
        describe:
          'The owner/repo the reviewed PR lives in — strengthens the authorisation binding for URL-shaped review arguments; omit to bind by PR number alone',
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
        implies: 'findings',
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
      reviewedRepo: argv['reviewed-repo'] as string | undefined,
      files: argv['files'] as string[] | undefined,
      findings: argv['findings'] as string | undefined,
      findingsOut: argv['findings-out'] as string | undefined,
      out: argv['out'] as string,
      host: argv['host'] as string | undefined,
      userAuthorized: Boolean(argv['user-authorized']),
      skillArgs: argv['skill-args'] as string | undefined,
      // The same operator-scope resolution as `submit`: the two callers of
      // the shared gate must agree on what authorises a run, or a run that
      // posts the review still refuses to publish its evidence images.
      defaultComment: operatorReviewSettings().comment,
    });
  },
};
