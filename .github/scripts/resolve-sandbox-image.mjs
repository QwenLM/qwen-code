#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GHCR_REPOSITORY = 'qwenlm/qwen-code';
const FETCH_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

async function responseError(response, label) {
  const body = await response.text();
  return new Error(
    `${label}: ${response.status} ${body.slice(0, 200)}`.trimEnd(),
  );
}

export function latestSemverTag(tags) {
  return tags
    .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    })
    .at(-1);
}

export function validateRequestedImage(image) {
  const requestedImage = image?.trim();
  if (
    !requestedImage ||
    requestedImage === 'undefined' ||
    requestedImage === 'null'
  ) {
    throw new Error(
      'package.json config.sandboxImageUri must be set to a sandbox image.',
    );
  }
  return requestedImage;
}

async function fetchLatestGhcrSemver() {
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${GHCR_REPOSITORY}:pull`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!tokenResponse.ok) {
    throw await responseError(tokenResponse, 'Failed to fetch GHCR token');
  }

  const { token } = await tokenResponse.json();
  const tagsResponse = await fetch(
    `https://ghcr.io/v2/${GHCR_REPOSITORY}/tags/list?n=1000`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!tagsResponse.ok) {
    throw await responseError(tagsResponse, 'Failed to fetch GHCR tags');
  }

  const { tags = [] } = await tagsResponse.json();
  if (tags.length >= 1000) {
    console.warn(
      '::warning::GHCR returned at least 1000 tags; latest semver may be inaccurate without pagination.',
    );
  }
  const latest = latestSemverTag(tags);
  if (!latest) {
    throw new Error('No semver GHCR tags found for qwen-code.');
  }
  return latest;
}

// The `Digest: sha256:…` line docker prints for the tag it just resolved is
// the only pull-time content identity: the post-pull inspect can race a
// `docker tag` swap (see repoDigestOf), so the exported reference must be
// bound to what the pull itself reported, never to inspect alone.
export function parsePullDigest(pullOutput) {
  return pullOutput.match(/^Digest: (sha256:[0-9a-f]{64})\s*$/m)?.[1] ?? '';
}

export function pullImage(command, image) {
  return new Promise((resolve) => {
    const child = spawn(command, ['pull', image], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      console.error(
        `::error::Timed out pulling ${image} after ${PULL_TIMEOUT_MS / 1000}s.`,
      );
      child.kill('SIGKILL');
      finish({ ok: false, digest: '' });
    }, PULL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', (error) => {
      console.error(
        `::error::Failed to start '${command} pull ${image}': ${error.message}`,
      );
      finish({ ok: false, digest: '' });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(
          `::error::'${command} pull ${image}' exited with code ${code}.`,
        );
        finish({ ok: false, digest: '' });
        return;
      }
      finish({ ok: true, digest: parsePullDigest(stdout) });
    });
  });
}

// Resolve a PULLED image to its content digest (repo@sha256:…). The tag
// alone is a mutable local handle: `docker run <tag>` resolves against the
// local store without re-pull, and a co-resident process with daemon access
// can `docker tag` different content under the same name between resolve
// and gate. A digest reference cannot be moved by `docker tag`/`docker build`.
// With `expectedDigest` (the pull's own `Digest:` line), the resolved digest
// must MATCH it: retagged attacker content keeps ITS original repo in
// RepoDigests[0] (and a requested-repo entry still carries the attacker
// digest), so only the digest the pull reported binds the export to the
// content the pull fetched (#9214 review).
export function repoDigestOf(command, image, expectedDigest = '') {
  return new Promise((resolve) => {
    const child = spawn(
      command,
      ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      console.error(
        `::error::Timed out inspecting ${image} after ${FETCH_TIMEOUT_MS / 1000}s.`,
      );
      child.kill('SIGKILL');
      finish('');
    }, FETCH_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', (error) => {
      console.error(
        `::error::Failed to start '${command} image inspect ${image}': ${error.message}`,
      );
      finish('');
    });
    child.on('close', (code) => {
      finish(code === 0 ? stdout.trim() : '');
    });
  }).then((digest) => {
    // `<no value>` is what the Go template prints for an image without
    // RepoDigests (a locally built one); empty means the inspect failed.
    // Either way the mutable tag is exactly what must not be exported.
    if (!digest.includes('@sha256:')) {
      throw new Error(
        `Pulled image ${image} resolved to no repository digest ('${digest}'); refusing to export a mutable tag.`,
      );
    }
    if (expectedDigest && !digest.endsWith(`@${expectedDigest}`)) {
      throw new Error(
        `Pulled image ${image} resolved to a digest the pull did not report ('${digest}' vs '${expectedDigest}') — the tag moved between pull and inspect; refusing.`,
      );
    }
    return digest;
  });
}

export function exportImage(image) {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `QWEN_SANDBOX_IMAGE=${image}\n`);
  }
  // Also as a step OUTPUT: $GITHUB_ENV is a file later steps can append to,
  // so a consumer that must not be steered by branch code (the verification
  // gate's container image) reads the expression-context value instead.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  }
  console.log(`QWEN_SANDBOX_IMAGE=${image}`);
}

async function main() {
  const requestedImage = validateRequestedImage(process.argv[2]);

  const command = process.env.SANDBOX_COMMAND || 'docker';
  const requestedPull = await pullImage(command, requestedImage);
  if (requestedPull.ok) {
    if (!requestedPull.digest) {
      throw new Error(
        `'${command} pull ${requestedImage}' reported no Digest line; refusing to export an unbound image reference.`,
      );
    }
    exportImage(
      await repoDigestOf(command, requestedImage, requestedPull.digest),
    );
    return;
  }

  const latest = await fetchLatestGhcrSemver();
  const fallbackImage = `ghcr.io/${GHCR_REPOSITORY}:${latest}`;
  if (fallbackImage === requestedImage) {
    throw new Error(
      `Requested sandbox image failed to pull: ${requestedImage}`,
    );
  }

  console.warn(
    `::warning::Falling back from ${requestedImage} to latest GHCR semver ${fallbackImage}; sandbox image version may differ from package version.`,
  );
  const fallbackPull = await pullImage(command, fallbackImage);
  if (!fallbackPull.ok) {
    throw new Error(`Fallback sandbox image failed to pull: ${fallbackImage}`);
  }
  if (!fallbackPull.digest) {
    throw new Error(
      `'${command} pull ${fallbackImage}' reported no Digest line; refusing to export an unbound image reference.`,
    );
  }
  exportImage(await repoDigestOf(command, fallbackImage, fallbackPull.digest));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
