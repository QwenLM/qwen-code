/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  buildComment,
  classifyMagic,
  MAX_BYTES,
  MAX_CANDIDATES,
  MAX_GIFS,
  MAX_SCREENSHOTS,
  sanitizeName,
  selectImages,
  selectRenderShapingFiles,
} from './web-shell-visuals-publish.mjs';

const PNG = '89504e470d0a1a0a';
const GIF89 = '474946383961';
const GIF87 = '474946383761';
const workflow = readFileSync(
  '.github/workflows/web-shell-visuals-publish.yml',
  'utf8',
);

test('workflow hosts visuals on OSS without writing Git refs', () => {
  assert.match(workflow, /scripts\/upload-aliyun-oss-assets\.js/);
  // Head SHA, run id AND run attempt: GitHub's camo proxy caches comment
  // images by URL, so a re-run for the same head must not write back over
  // the object the previous comment already published — and the run id is
  // stable across re-run attempts, so the attempt must be in the key too.
  assert.match(
    workflow,
    /pr-assets\/web-shell-visuals\/\$\{PR\}\/\$\{RUN_HEAD_SHA\}\/\$\{RUN_ID\}\/\$\{RUN_ATTEMPT\}/,
  );
  assert.match(workflow, /ALIYUN_OSS_PUBLIC_BASE_URL/);
  assert.match(
    workflow,
    /RUN_ATTEMPT: '\$\{\{ github\.event\.workflow_run\.run_attempt \}\}'/,
  );
  assert.match(workflow, /PATH="\$trusted_bin" "\$node_bin"/);
  // ossutil must run from a fresh job-private dir, never $RUNNER_TEMP: a
  // trusted_bin=$RUNNER_TEMP mutant would re-resolve the binary through the
  // shared dir on every call and survive the PATH assertion above.
  assert.match(workflow, /trusted_bin="\$\(mktemp -d\)"/);
  assert.match(
    workflow,
    /install -m 0755 "\$\{RUNNER_TEMP\}\/ossutil" "\$trusted_bin\/ossutil"/,
  );
  assert.doesNotMatch(workflow, /PATH="\$RUNNER_TEMP:\$PATH"/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /checkout -q --orphan/);
});

test('workflow checks out only trusted base-repo scripts', () => {
  // The job carries OSS credentials. Its checkout must pin the trusted ref
  // (on workflow_run events github.sha is the default-branch head, never
  // the PR head) and take only the publisher files — dropping /package.json
  // makes the uploader's `.js` stop parsing as ESM on Node versions that
  // don't infer module syntax, and this job pins no Node.
  const checkout =
    workflow.split("'Checkout the publish scripts'")[1]?.split('- name:')[0] ??
    '';
  assert.ok(checkout, 'checkout step not found');
  assert.match(checkout, /ref: '\$\{\{ github\.sha \}\}'/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(checkout, /sparse-checkout-cone-mode: false/);
  for (const entry of [
    '/package.json',
    '.github/scripts/web-shell-visuals-publish.mjs',
    'scripts/upload-aliyun-oss-assets.js',
    'scripts/release-script-utils.js',
  ]) {
    assert.ok(
      checkout.includes(`\n            ${entry}\n`),
      `sparse-checkout entry missing: ${entry}`,
    );
  }
});

test('workflow derives the public URL from the resolved bucket', () => {
  // Overriding only one of the bucket/base-URL vars must not post comment
  // links that 404 against (or show stale objects from) the other bucket:
  // the default base URL is derived from whichever bucket wins.
  const publish =
    workflow.split("'Publish visuals to the PR'")[1]?.split('run: |-')[0] ?? '';
  assert.ok(publish, 'publish step env not found');
  assert.match(
    publish,
    /ALIYUN_OSS_BUCKET: "\$\{\{ vars\.ALIYUN_OSS_PR_ASSETS_BUCKET \|\| vars\.ALIYUN_OSS_BUCKET \|\| 'qwen-code-assets' \}\}"/,
  );
  assert.match(
    publish,
    /ALIYUN_OSS_PUBLIC_BASE_URL: "\$\{\{ vars\.ALIYUN_OSS_PR_ASSETS_PUBLIC_BASE_URL \|\| \(vars\.ALIYUN_OSS_PR_ASSETS_BUCKET == '' && vars\.ALIYUN_OSS_PUBLIC_BASE_URL\) \|\| format\('https:\/\/\{0\}\.oss-cn-hangzhou\.aliyuncs\.com', vars\.ALIYUN_OSS_PR_ASSETS_BUCKET \|\| vars\.ALIYUN_OSS_BUCKET \|\| 'qwen-code-assets'\) \}\}"/,
  );
  // A stalled upload is bounded per attempt so one black-hole socket cannot
  // burn the whole 10-minute job cap and strand the preview comment.
  assert.match(publish, /OSS_UPLOAD_ATTEMPT_TIMEOUT_MS: '120000'/);
});

test('workflow keeps the ossutil download retry budget inside the job cap', () => {
  // A CDN retry loop whose worst case exceeds the 10-minute job cap turns
  // the intended "degrade to the no-image path" into "job killed mid-install".
  const install =
    workflow.split("'Install ossutil'")[1]?.split('- name:')[0] ?? '';
  const m = install.match(
    /curl -fsSL --retry (\d+) --retry-delay (\d+) --retry-all-errors \\\n\s+--connect-timeout (\d+) --max-time (\d+)/,
  );
  assert.ok(m, 'curl retry flags not found in the install step');
  const worstSeconds =
    (Number(m[1]) + 1) * Number(m[4]) + Number(m[1]) * Number(m[2]);
  assert.ok(
    worstSeconds < 10 * 60,
    `worst-case download budget ${worstSeconds}s exceeds the 10-minute job cap`,
  );
});

test('workflow pins the ossutil credential lifecycle (sha256 install, config, always() cleanup)', () => {
  // The sha256-verified install and the credential config it feeds are
  // best-effort here (a setup failure must not block the no-image path)...
  const install =
    workflow.split("'Install ossutil'")[1]?.split('- name:')[0] ?? '';
  assert.match(install, /continue-on-error: true/);
  assert.match(install, /sha256sum -c/);
  const configure =
    workflow
      .split("'Configure Aliyun OSS credentials'")[1]
      ?.split('- name:')[0] ?? '';
  assert.match(configure, /continue-on-error: true/);
  assert.match(configure, /-c "\$RUNNER_TEMP\/\.ossutilconfig"/);
  // ...but the cleanup must run even on failure, or the OSS key pair
  // lingers in $RUNNER_TEMP after the job.
  const cleanup = workflow.split("'Cleanup Aliyun OSS credentials'")[1] ?? '';
  assert.match(cleanup, /if: '\$\{\{ always\(\) \}\}'/);
  assert.match(cleanup, /rm -f "\$RUNNER_TEMP\/\.ossutilconfig"/);
});

// --- Behavioural coverage for the OSS hosting block -----------------------
// The shape regexes above pin the hosting contract as text; this harness
// EXECUTES the extracted hosting block against a stub uploader that mirrors
// scripts/upload-aliyun-oss-assets.js's flag contract (readOptionValue
// rejects a valueless --bucket/--config/--prefix; at least one asset is
// required) and records where the objects land — the same stub-uploader
// pattern as the verify path in scripts/tests/qwen-triage-workflow.test.js.
// A --prefix that drifts away from RAW_BASE (every preview URL 404s) or a
// dropped --config (the real uploader dies before any comment posts) fails
// here, where the shape regexes stay green.

function hostingBlockSource() {
  const raw = workflow
    .split('# --- Host on Aliyun OSS')[1]
    ?.split('\n')
    .slice(1) // drop the marker line's trailing dashes — not a comment.
    .join('\n')
    .split('# --- Changed paths')[0]
    .replace(/^ {10}/gm, ''); // the step run block's indentation.
  assert.ok(raw, 'hosting block markers not found in the publish workflow');
  return raw;
}

function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

function runHostingBlock(
  hasImages,
  {
    publicBaseUrl = 'https://assets.example.test',
    uploadFails = false,
    runId = '900001',
    runAttempt = '1',
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'visuals-hosting-'));
  try {
    return runHostingBlockIn(dir, hasImages, {
      publicBaseUrl,
      uploadFails,
      runId,
      runAttempt,
    });
  } finally {
    // The fixture used to leak a mkdtemp dir per call; capture everything
    // the assertions need inside, then tear it down.
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHostingBlockIn(
  dir,
  hasImages,
  { publicBaseUrl, uploadFails, runId, runAttempt },
) {
  const runnerTemp = join(dir, 'runner-temp');
  const stage = join(dir, 'stage');
  const work = join(dir, 'work');
  const stubRoot = join(dir, 'oss');
  const recordPath = join(dir, 'upload-record.json');
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  // The block installs its job-private ossutil copy from here; the stub
  // uploader never executes it, but the install must succeed.
  writeFileSync(join(runnerTemp, 'ossutil'), 'fake ossutil\n');
  writeFileSync(join(stage, 'home-light.png'), 'png-bytes');
  writeFileSync(join(stage, 'model-switch.gif'), 'gif-bytes');
  // Stub uploader: enforces the real flag contract, then copies the objects
  // under $OSS_STUB_ROOT/<bucket>/<prefix> and records the flags it saw.
  writeFileSync(
    join(work, 'scripts', 'upload-aliyun-oss-assets.js'),
    [
      "'use strict';",
      "const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { basename, join } = require('node:path');",
      "if (process.env.OSS_STUB_FAIL === '1') process.exit(1);",
      "const opts = { bucket: '', config: '', prefix: '' };",
      'const assets = [];',
      'const argv = process.argv.slice(2);',
      'for (let i = 0; i < argv.length; i += 1) {',
      '  const arg = argv[i];',
      "  if (arg === '--bucket' || arg === '--config' || arg === '--prefix') {",
      '    opts[arg.slice(2)] = argv[i + 1] ?? "";',
      '    i += 1;',
      '  } else {',
      '    assets.push(arg);',
      '  }',
      '}',
      'for (const [name, value] of Object.entries(opts)) {',
      '  if (!value || value.startsWith("-")) {',
      '    console.error(`upload-assets stub: --${name} requires a value`);',
      '    process.exit(1);',
      '  }',
      '}',
      'if (assets.length === 0) {',
      '  console.error("upload-assets stub: at least one ASSET path is required");',
      '  process.exit(1);',
      '}',
      'const target = join(process.env.OSS_STUB_ROOT, opts.bucket, opts.prefix);',
      'mkdirSync(target, { recursive: true });',
      'for (const file of assets) {',
      '  copyFileSync(file, join(target, basename(file)));',
      '}',
      'writeFileSync(process.env.OSS_STUB_RECORD, JSON.stringify(opts));',
    ].join('\n'),
  );
  const pr = '4242';
  const headSha = 'cafe4242cafe4242cafe4242cafe4242cafe4242';
  const script = [
    'set -euo pipefail',
    `HAS_IMAGES=${hasImages ? 1 : 0}`,
    `PR=${pr}`,
    `RUN_HEAD_SHA=${headSha}`,
    `RUN_ID=${runId}`,
    `RUN_ATTEMPT=${runAttempt}`,
    `STAGE=${JSON.stringify(stage)}`,
    'ALIYUN_OSS_BUCKET=assets-bucket',
    `ALIYUN_OSS_PUBLIC_BASE_URL=${JSON.stringify(publicBaseUrl)}`,
    `RUNNER_TEMP=${JSON.stringify(runnerTemp)}`,
    hostingBlockSource(),
    'printf \'RAW_BASE=%s\\n\' "$RAW_BASE"',
  ].join('\n');
  const driverPath = join(dir, 'driver.sh');
  writeFileSync(driverPath, script);
  const res = spawnSync('bash', [driverPath], {
    encoding: 'utf8',
    cwd: work,
    env: {
      ...process.env,
      OSS_STUB_ROOT: stubRoot,
      OSS_STUB_RECORD: recordPath,
      OSS_STUB_FAIL: uploadFails ? '1' : '0',
    },
  });
  // Capture the outcomes the caller asserts on before the fixture dir is
  // torn down: the parsed upload record (null when the uploader never ran
  // or wrote nothing) and the flat listing of everything hosted.
  const record = existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : null;
  const hostedFiles = listFiles(stubRoot).sort();
  const hostingStatusPath = join(runnerTemp, 'visuals-hosting-status.txt');
  const hostingStatus = existsSync(hostingStatusPath)
    ? readFileSync(hostingStatusPath, 'utf8').trim()
    : null;
  return {
    res,
    record,
    hostedFiles,
    hostingStatus,
    pr,
    headSha,
    runId,
    runAttempt,
    runnerTemp,
  };
}

test('hosting block uploads staged images to the exact prefix RAW_BASE promises', () => {
  const {
    res,
    record,
    hostedFiles,
    hostingStatus,
    pr,
    headSha,
    runId,
    runAttempt,
    runnerTemp,
  } = runHostingBlock(true);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(hostingStatus, 'success');
  // Flag wiring: the uploader gets the bucket, the credential file the
  // configure step writes, and the prefix the comment URLs are built from.
  const prefix = `pr-assets/web-shell-visuals/${pr}/${headSha}/${runId}/${runAttempt}`;
  assert.deepEqual(record, {
    bucket: 'assets-bucket',
    config: `${runnerTemp}/.ossutilconfig`,
    prefix,
  });
  // Upload-prefix ↔ URL agreement: the objects land exactly where RAW_BASE
  // (the comment's image base URL) points.
  assert.deepEqual(hostedFiles, [
    `assets-bucket/${prefix}/home-light.png`,
    `assets-bucket/${prefix}/model-switch.gif`,
  ]);
  assert.match(
    res.stdout,
    new RegExp(
      `^RAW_BASE=https://assets\\.example\\.test/pr-assets/web-shell-visuals/${pr}/${headSha}/${runId}/${runAttempt}$`,
      'm',
    ),
  );
  assert.match(
    res.stdout,
    new RegExp(
      `Web-shell visuals hosted at https://assets\\.example\\.test/pr-assets/web-shell-visuals/${pr}/${headSha}/${runId}/${runAttempt}\\.`,
    ),
  );
});

// The regression this guards: publishing back onto the previous run's object
// keys. GitHub serves comment images through a caching proxy, so a re-run for
// the same head would keep showing the stale screenshots. A re-run comes in
// TWO shapes: a brand-new workflow run (fresh run id) and a re-run of the
// SAME run — which keeps the run id and only increments the attempt, and
// still re-fires workflow_run `completed`. Both must get fresh prefixes;
// dropping the attempt component from ASSET_PREFIX turns this red.
test('hosting block gives a re-run of the same head a fresh, non-colliding prefix', () => {
  const first = runHostingBlock(true, { runId: '900001', runAttempt: '1' });
  assert.equal(first.res.status, 0, first.res.stderr);
  const rerunSameRun = runHostingBlock(true, {
    runId: '900001',
    runAttempt: '2',
  });
  assert.equal(rerunSameRun.res.status, 0, rerunSameRun.res.stderr);
  const freshRun = runHostingBlock(true, { runId: '900002', runAttempt: '1' });
  assert.equal(freshRun.res.status, 0, freshRun.res.stderr);
  const prefixes = [first, rerunSameRun, freshRun].map((r) => r.record.prefix);
  assert.equal(new Set(prefixes).size, 3);
  // All still hang off the same immutable per-head path, so the head SHA
  // stays the thing that binds a URL to the code it depicts.
  const head = `pr-assets/web-shell-visuals/${first.pr}/${first.headSha}/`;
  for (const prefix of prefixes) {
    assert.ok(prefix.startsWith(head), `unexpected prefix: ${prefix}`);
  }
});

// A maintainer re-run of the SAME workflow run keeps its run id — only
// run_attempt increments. Without the attempt segment the re-run would
// overwrite the exact object keys the attempt-1 comment already references
// (and camo-cached), so attempts of one run must land on distinct prefixes.
test('hosting block gives re-run attempts of the SAME run distinct prefixes', () => {
  const first = runHostingBlock(true, { runId: '900001', runAttempt: '1' });
  assert.equal(first.res.status, 0, first.res.stderr);
  const second = runHostingBlock(true, { runId: '900001', runAttempt: '2' });
  assert.equal(second.res.status, 0, second.res.stderr);
  const prefixOf = (r) => r.record.prefix;
  assert.equal(
    prefixOf(first),
    `pr-assets/web-shell-visuals/${first.pr}/${first.headSha}/900001/1`,
  );
  assert.equal(
    prefixOf(second),
    `pr-assets/web-shell-visuals/${first.pr}/${first.headSha}/900001/2`,
  );
  assert.notEqual(prefixOf(first), prefixOf(second));
});

test('hosting block skips the uploader entirely on the no-change arm', () => {
  const { res, record, hostingStatus } = runHostingBlock(false);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^RAW_BASE=$/m); // empty -> image-less comment
  assert.doesNotMatch(res.stdout, /hosted at/);
  assert.equal(record, null); // the uploader never ran
  assert.equal(hostingStatus, 'success');
});

test('hosting block records failure and continues without publishing a URL', () => {
  const { res, record, hostingStatus } = runHostingBlock(true, {
    uploadFails: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^RAW_BASE=$/m);
  assert.match(res.stdout, /Failed to host web-shell visuals/);
  assert.equal(record, null);
  assert.equal(hostingStatus, 'failure');
});

test('hosting block strips a trailing slash from the public base URL', () => {
  const { res, pr, headSha, runId, runAttempt } = runHostingBlock(true, {
    publicBaseUrl: 'https://assets.example.test/',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(
    res.stdout,
    new RegExp(
      `^RAW_BASE=https://assets\\.example\\.test/pr-assets/web-shell-visuals/${pr}/${headSha}/${runId}/${runAttempt}$`,
      'm',
    ),
  );
  assert.doesNotMatch(res.stdout, /assets\.example\.test\/\/pr-assets/);
});

const publishWorkflow = () =>
  readFileSync(
    new URL('../workflows/web-shell-visuals-publish.yml', import.meta.url),
    'utf8',
  );
const publishScriptPath = fileURLToPath(
  new URL('./web-shell-visuals-publish.mjs', import.meta.url),
);
const publishStep = () => {
  const workflow = parse(publishWorkflow());
  return workflow.jobs.publish.steps.find(
    (step) => step.name === 'Publish visuals to the PR',
  ).run;
};

const writeExecutable = (path, source) => {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
};

const runPublishStep = ({ uploadSucceeds, script = publishStep() }) => {
  const root = mkdtempSync(join(tmpdir(), 'web-shell-visuals-workflow-'));
  try {
    const workspace = join(root, 'workspace');
    const runnerTemp = join(root, 'runner');
    const bin = join(root, 'bin');
    const callLog = join(root, 'calls.log');
    const scriptDir = join(workspace, '.github', 'scripts');
    mkdirSync(join(workspace, 'visuals', 'screenshots'), { recursive: true });
    mkdirSync(join(workspace, 'visuals', 'gifs'), { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(runnerTemp);
    mkdirSync(bin);
    writeFileSync(join(workspace, 'visuals', 'pr.txt'), '7\n');
    writeFileSync(
      join(workspace, 'visuals', 'screenshots', 'home-light.png'),
      Buffer.from(PNG, 'hex'),
    );
    writeFileSync(join(workspace, 'visuals', 'render-status.txt'), 'success\n');
    copyFileSync(
      publishScriptPath,
      join(scriptDir, 'web-shell-visuals-publish.mjs'),
    );
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    writeFileSync(
      join(workspace, 'scripts', 'upload-aliyun-oss-assets.js'),
      "process.exit(process.env.UPLOAD_SUCCEEDS === '1' ? 0 : 1);\n",
    );
    writeExecutable(join(runnerTemp, 'ossutil'), '#!/bin/sh\nexit 0\n');
    writeExecutable(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.CALL_LOG, args.join(' ') + '\\n');
const endpoint = args[1] ?? '';
if (endpoint === 'user') {
  process.stdout.write('qwen-code-bot\\n');
} else if (endpoint.endsWith('/pulls/7')) {
  process.stdout.write(JSON.stringify({
    state: 'open',
    head: {
      sha: process.env.RUN_HEAD_SHA,
      repo: { full_name: process.env.RUN_HEAD_REPO },
      ref: process.env.RUN_HEAD_BRANCH,
    },
  }));
} else if (endpoint.endsWith('/issues/7/comments') && args.includes('--method')) {
  process.stdout.write('[]\\n');
}
`,
    );
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

    const result = spawnSync('bash', ['-c', script], {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CALL_LOG: callLog,
        UPLOAD_SUCCEEDS: uploadSucceeds ? '1' : '0',
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'QwenLM/qwen-code',
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        RUN_ID: '99',
        RUN_ATTEMPT: '2',
        RUN_URL: 'https://run.example/99',
        RUN_HEAD_SHA: '1234567890abcdef',
        RUN_HEAD_REPO: 'fork/qwen-code',
        RUN_HEAD_BRANCH: 'fix/visuals',
        ALIYUN_OSS_BUCKET: 'assets-bucket',
        ALIYUN_OSS_PUBLIC_BASE_URL: 'https://assets.example.test',
        OSS_UPLOAD_ATTEMPT_TIMEOUT_MS: '120000',
      },
    });
    const bodyPath = join(runnerTemp, 'visuals-comment.md');
    return {
      ...result,
      body: readFileSync(bodyPath, 'utf8'),
      calls: readFileSync(callLog, 'utf8'),
      hostingStatus: readFileSync(
        join(runnerTemp, 'visuals-hosting-status.txt'),
        'utf8',
      ).trim(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('sanitizeName preserves the extension (regression: a trailing char broke the .png filter)', () => {
  assert.equal(
    sanitizeName('session-transcript-light.png'),
    'session-transcript-light.png',
  );
  assert.match(sanitizeName('model-dialog-dark.png'), /\.png$/);
  assert.match(sanitizeName('model-switch.gif'), /\.gif$/);
  // Disallowed characters become `_`, but the extension is untouched.
  assert.equal(sanitizeName('weird name!.png'), 'weird_name_.png');
  assert.equal(sanitizeName('trailing.png\n'), 'trailing.png_');
});

test('classifyMagic accepts real PNG/GIF magic and rejects mismatches', () => {
  assert.equal(classifyMagic('png', PNG), 'png');
  assert.equal(classifyMagic('gif', GIF89), 'gif');
  assert.equal(classifyMagic('gif', GIF87), 'gif');
  assert.equal(classifyMagic('png', GIF89), null); // GIF bytes in a .png
  assert.equal(classifyMagic('gif', PNG), null); // PNG bytes in a .gif
  assert.equal(classifyMagic('png', 'deadbeefdeadbeef'), null);
  assert.equal(classifyMagic('svg', PNG), null); // unknown extension
});

test('selectImages accepts valid images and keeps safe, extension-correct names', () => {
  const { accepted, warnings } = selectImages([
    { name: 'a-light.png', ext: 'png', size: 100, magic: PNG },
    { name: 'a-dark.png', ext: 'png', size: 100, magic: PNG },
    { name: 'model-switch.gif', ext: 'gif', size: 100, magic: GIF89 },
  ]);
  assert.equal(accepted.length, 3);
  assert.deepEqual(
    accepted.map((a) => a.safeName),
    ['a-light.png', 'a-dark.png', 'model-switch.gif'],
  );
  assert.deepEqual(warnings, []);
});

test('selectImages skips oversized and magic-invalid files', () => {
  let r = selectImages([
    { name: 'big.png', ext: 'png', size: MAX_BYTES + 1, magic: PNG },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('exceeds')));

  r = selectImages([{ name: 'fake.png', ext: 'png', size: 10, magic: GIF89 }]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('not a valid')));
});

test('selectImages caps screenshots per-kind WITHOUT starving gifs', () => {
  const many = [
    ...Array.from({ length: MAX_SCREENSHOTS + 5 }, (_, i) => ({
      name: `s${i}-light.png`,
      ext: 'png',
      size: 10,
      magic: PNG,
    })),
    { name: 'model-switch.gif', ext: 'gif', size: 10, magic: GIF89 },
  ];
  const { accepted } = selectImages(many);
  const png = accepted.filter((a) => a.kind === 'png').length;
  const gif = accepted.filter((a) => a.kind === 'gif').length;
  assert.equal(png, MAX_SCREENSHOTS); // screenshots capped
  assert.equal(gif, 1); // the gif survives the screenshot flood (not starved)
});

test('selectImages caps gifs per-kind', () => {
  const gifs = Array.from({ length: MAX_GIFS + 3 }, (_, i) => ({
    name: `flow${i}.gif`,
    ext: 'gif',
    size: 10,
    magic: GIF89,
  }));
  assert.equal(selectImages(gifs).accepted.length, MAX_GIFS);
});

test('selectImages bounds EXAMINED candidates so a junk flood cannot run forever', () => {
  const flood = Array.from({ length: MAX_CANDIDATES + 50 }, (_, i) => ({
    name: `x${i}.png`,
    ext: 'png',
    size: 10,
    magic: '00000000', // all invalid
  }));
  const { accepted, warnings } = selectImages(flood);
  assert.equal(accepted.length, 0);
  assert.ok(warnings.some((w) => w.includes('candidate files')));
});

test('buildComment lists before/after composites, labels flows, escapes, links the run', () => {
  const body = buildComment(
    [
      'session-transcript-light.png',
      'session-transcript-dark.png',
      'model-switch.gif',
    ],
    {
      rawBase: 'https://raw.example/imgs',
      shortSha: 'abc1234',
      runUrl: 'https://run.example/1',
    },
  );
  assert.match(body, /<!-- qwen:web-shell-visuals -->/);
  assert.match(body, /session-transcript-light\.png/);
  assert.match(body, /session-transcript-dark\.png/);
  assert.match(body, /Only \*\*screenshots\*\* that changed are shown/); // before/after framing
  assert.match(body, /model-switch\.gif/);
  assert.match(body, /Open the slash menu and switch model/); // flow label
  assert.match(body, /abc1234/);
  assert.match(body, /https:\/\/run\.example\/1/);
  // Each changed composite is listed as its own wide image (light + dark).
  const shotImgs = body
    .split('\n')
    .filter((l) => /^<img /.test(l) && /\.png/.test(l));
  assert.equal(shotImgs.length, 2);
  assert.doesNotMatch(body, /<table>/); // composites are a list, not a table
});

test('buildComment does not leak Object.prototype members as flow labels', () => {
  const body = buildComment(['toString.gif', 'constructor.gif'], {
    rawBase: 'r',
  });
  assert.doesNotMatch(body, /native code/);
  assert.match(body, /\*\*ToString\*\*/); // falls back to the prettified filename
});

test('buildComment says "no visual changes" when there are no composites', () => {
  const empty = buildComment([], { shortSha: 'abc1234' });
  assert.match(empty, /web-shell visual preview/);
  assert.doesNotMatch(empty, /<img /); // no screenshots, no flows
  assert.match(empty, /No screenshot changes against the PR base/);
});

test('buildComment lists a lone composite as one wide image (no light/dark table)', () => {
  const body = buildComment(['home-light.png'], { rawBase: 'r' });
  assert.match(body, /<img src="r\/home-light\.png" width="900"/);
  assert.doesNotMatch(body, /<table>/); // composites are a flat list now
  // A lone light shot no longer needs a dark-pair placeholder cell.
  assert.doesNotMatch(body, /<td>/);
});

test('buildComment: hosting failure reports rendered assets without broken image links', () => {
  const body = buildComment(['home-light.png', 'model-switch.gif'], {
    hostingFailed: true,
    runUrl: 'https://run.example/7',
  });
  assert.match(body, /failed to host/i);
  assert.match(body, /home-light\.png/);
  assert.match(body, /model-switch\.gif/);
  assert.match(body, /\[workflow run\]\(https:\/\/run\.example\/7\)/);
  assert.doesNotMatch(body, /failed to render/i);
  assert.doesNotMatch(body, /<img /);
});

test('buildComment: hosting failure preserves render-failure caveat', () => {
  const body = buildComment(['home-light.png', 'model-switch.gif'], {
    hostingFailed: true,
    renderIncomplete: true,
    runUrl: 'https://run.example/7',
  });
  assert.match(body, /failed to render/i);
  assert.match(body, /failed to host/i);
  assert.match(body, /\[workflow run\]\(https:\/\/run\.example\/7\)/);
  assert.doesNotMatch(body, /<img /);
});

test('comment CLI reads hosting failure status from the eighth argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-shell-visuals-'));
  try {
    const stageDir = join(root, 'stage');
    const bodyFile = join(root, 'body.md');
    const changedPathsFile = join(root, 'paths.txt');
    const renderStatusFile = join(root, 'render-status.txt');
    const hostingStatusFile = join(root, 'hosting-status.txt');
    mkdirSync(stageDir);
    writeFileSync(join(stageDir, 'home-light.png'), '');
    writeFileSync(changedPathsFile, '');
    writeFileSync(renderStatusFile, 'success\n');
    writeFileSync(hostingStatusFile, 'failure\n');

    execFileSync(process.execPath, [
      publishScriptPath,
      'comment',
      stageDir,
      'https://assets.example/pr',
      'abc1234',
      'https://run.example/7',
      bodyFile,
      changedPathsFile,
      renderStatusFile,
      hostingStatusFile,
    ]);

    const body = readFileSync(bodyFile, 'utf8');
    assert.match(body, /failed to host/i);
    assert.doesNotMatch(body, /<img /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Empty-preview triage (coverage gap vs. genuinely no visual effect) ---

test('selectRenderShapingFiles keeps rendered .tsx/.css/.svg and drops logic/test/other-package edits', () => {
  const { files, total } = selectRenderShapingFiles([
    'packages/web-shell/client/components/WelcomeScreen.tsx',
    'packages/web-shell/client/components/worktree.module.css',
    'packages/webui/src/ui/button.tsx',
    'packages/web-shell/client/assets/icons/plan.svg',
    // Dropped: not a rendered extension...
    'packages/web-shell/client/hooks/useWorktree.ts',
    'packages/web-shell/client/types.d.ts',
    // ...not the rendered surface...
    'packages/core/src/utils/gitDiff.ts',
    'packages/web-shell/server/routes.tsx',
    'docs/web-shell.md',
    // ...or test/scenario code, which DRIVES the preview rather than being it.
    'packages/web-shell/client/e2e/visuals/screenshots.spec.ts',
    'packages/web-shell/client/components/Sidebar.test.tsx',
    'packages/web-shell/client/components/__tests__/Chip.tsx',
    // Blank lines from a trailing newline in the paths file.
    '',
    '   ',
  ]);
  assert.deepEqual(files, [
    'packages/web-shell/client/assets/icons/plan.svg',
    'packages/web-shell/client/components/WelcomeScreen.tsx',
    'packages/web-shell/client/components/worktree.module.css',
    'packages/webui/src/ui/button.tsx',
  ]);
  assert.equal(total, 4);
});

test('selectRenderShapingFiles caps the listed paths but reports the true total', () => {
  const many = Array.from(
    { length: 12 },
    (_, i) => `packages/web-shell/client/c/F${String(i).padStart(2, '0')}.tsx`,
  );
  const { files, total } = selectRenderShapingFiles(many, { maxListed: 3 });
  assert.equal(total, 12);
  assert.equal(files.length, 3);
  assert.equal(files[0], 'packages/web-shell/client/c/F00.tsx');
});

test('selectRenderShapingFiles tolerates a missing/undefined list', () => {
  assert.deepEqual(selectRenderShapingFiles(undefined), {
    files: [],
    total: 0,
  });
  assert.deepEqual(selectRenderShapingFiles([]), { files: [], total: 0 });
});

test('buildComment flags a possible COVERAGE GAP when UI changed but no view did', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    changedPaths: [
      'packages/web-shell/client/components/WelcomeScreen.tsx',
      'packages/web-shell/client/hooks/useWorktree.ts', // logic — not listed
    ],
  });
  // The bare green check would read as "nothing broke"; it must not appear.
  assert.doesNotMatch(body, /✅/);
  assert.match(body, /1 render-shaping file:/); // singular
  assert.match(
    body,
    /`packages\/web-shell\/client\/components\/WelcomeScreen\.tsx`/,
  );
  assert.doesNotMatch(body, /useWorktree\.ts/);
  assert.match(body, /no scenario renders this UI/);
  assert.match(body, /screenshots\.spec\.ts/); // tells you where to fix it
});

test('buildComment keeps the green check when only non-rendering files changed', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    changedPaths: [
      'packages/web-shell/client/hooks/useWorktree.ts',
      'packages/core/src/index.ts',
    ],
  });
  // A logic-only PR with no visual delta is EXPECTED — prompting here would
  // train everyone to ignore the prompt when it matters.
  assert.match(body, /✅ _No screenshot changes against the PR base\._/);
  assert.doesNotMatch(body, /coverage gap/);
});

test('buildComment does not triage when screenshots DID change', () => {
  const body = buildComment(['home-dark.png'], {
    rawBase: 'r',
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(body, /<img /);
  assert.doesNotMatch(body, /coverage gap/);
  assert.doesNotMatch(body, /render-shaping/);
});

test('buildComment summarises the overflow instead of listing every path', () => {
  const body = buildComment([], {
    changedPaths: Array.from(
      { length: 10 },
      (_, i) =>
        `packages/web-shell/client/c/F${String(i).padStart(2, '0')}.tsx`,
    ),
  });
  assert.match(body, /10 render-shaping files:/); // plural
  assert.match(body, /_…and 2 more\._/); // 10 - MAX_LISTED_PATHS(8)
  assert.equal(body.split('\n').filter((l) => /^- `/.test(l)).length, 8);
});

test('buildComment neutralises a path that tries to break out of its code span', () => {
  const body = buildComment([], {
    changedPaths: [
      'packages/web-shell/client/`<img src=x onerror=alert(1)>`.tsx',
    ],
  });
  assert.doesNotMatch(body, /<img /); // the injected tag never becomes HTML
  assert.match(body, /&lt;img src=x/); // escaped, inside the code span
  // Exactly one path bullet, and it opens and closes its own span.
  const bullets = body.split('\n').filter((l) => /^- `/.test(l));
  assert.equal(bullets.length, 1);
  assert.equal((bullets[0].match(/`/g) ?? []).length, 2);
});

// --- Render-incomplete honesty (a failed scenario must not read as "no change") ---

test('buildComment: empty preview + renderIncomplete says RENDER FAILED, not no-change or coverage-gap', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    runUrl: 'https://run.example/9',
    renderIncomplete: true,
    // Even with render-shaping files changed, a failed render must NOT show the
    // coverage-gap prompt — that would imply the render actually ran.
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(body, /failed to render/i);
  assert.doesNotMatch(body, /✅/); // never the clean check
  assert.doesNotMatch(body, /No screenshot changes against the PR base/);
  assert.doesNotMatch(body, /coverage gap/); // coverage-gap prompt suppressed
  assert.doesNotMatch(body, /render-shaping/);
  assert.match(body, /https:\/\/run\.example\/9/); // links the run
});

test('buildComment: composites present + renderIncomplete warns the preview is PARTIAL', () => {
  const body = buildComment(['home-dark.png'], {
    rawBase: 'r',
    runUrl: 'https://run.example/9',
    renderIncomplete: true,
  });
  assert.match(body, /<img src="r\/home-dark\.png"/); // the shots that rendered still show
  assert.match(body, /failed to render/i); // ...prefixed by the partial-preview warning
  assert.match(body, /may be missing views/i);
});

test('buildComment: renderIncomplete false keeps the existing no-change / coverage-gap behavior', () => {
  // Complete render, no shots, no render-shaping files → the plain green check.
  const clean = buildComment([], {
    shortSha: 'abc1234',
    renderIncomplete: false,
    changedPaths: ['packages/core/src/index.ts'],
  });
  assert.match(clean, /✅ _No screenshot changes against the PR base\._/);
  assert.doesNotMatch(clean, /failed to render/i);

  // Complete render, no shots, render-shaping files → the coverage-gap prompt.
  const gap = buildComment([], {
    shortSha: 'abc1234',
    renderIncomplete: false,
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(gap, /no scenario renders this UI/);
  assert.doesNotMatch(gap, /failed to render/i);
});

test('buildComment: render-failure note omits the run link when runUrl is absent', () => {
  const body = buildComment([], { renderIncomplete: true });
  assert.match(body, /failed to render/i);
  assert.doesNotMatch(body, /\[workflow run\]/); // no dangling empty link
});

test('publish workflow carries a hosting failure into the posted body', () => {
  const renamedSection = publishStep().replace(
    '# --- Post or update the PR comment',
    '# Write the PR comment',
  );
  const result = runPublishStep({
    uploadSucceeds: false,
    script: renamedSection,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.hostingStatus, 'failure');
  assert.match(result.body, /failed to host/i);
  assert.doesNotMatch(result.body, /<img /);
  assert.match(
    result.calls,
    /api repos\/QwenLM\/qwen-code\/issues\/7\/comments -F body=@/,
  );
});

test('publish workflow keeps successful hosting out of the failure path', () => {
  const result = runPublishStep({ uploadSucceeds: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.hostingStatus, 'success');
  assert.doesNotMatch(result.body, /failed to host/i);
  assert.match(
    result.body,
    /https:\/\/assets\.example\.test\/pr-assets\/web-shell-visuals\/7\/1234567890abcdef\/99\/2\/home-light\.png/,
  );
  assert.match(
    result.calls,
    /api repos\/QwenLM\/qwen-code\/issues\/7\/comments -F body=@/,
  );
});
