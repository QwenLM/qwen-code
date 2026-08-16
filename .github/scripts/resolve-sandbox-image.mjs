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

function pullImage(command, image) {
  return new Promise((resolve) => {
    const child = spawn(command, ['pull', image], { stdio: 'inherit' });
    let settled = false;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => {
      console.error(
        `::error::Timed out pulling ${image} after ${PULL_TIMEOUT_MS / 1000}s.`,
      );
      child.kill('SIGKILL');
      finish(false);
    }, PULL_TIMEOUT_MS);

    child.on('error', (error) => {
      console.error(
        `::error::Failed to start '${command} pull ${image}': ${error.message}`,
      );
      finish(false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(
          `::error::'${command} pull ${image}' exited with code ${code}.`,
        );
      }
      finish(code === 0);
    });
  });
}

// Resolve a PULLED image to its content digest (repo@sha256:…). The tag
// alone is a mutable local handle: `docker run <tag>` resolves against the
// local store without re-pull, and a co-resident process with daemon access
// can `docker tag` different content under the same name between resolve
// and gate. A digest reference cannot be moved by `docker tag`/`docker build`.
export function repoDigestOf(command, image) {
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
  if (await pullImage(command, requestedImage)) {
    exportImage(await repoDigestOf(command, requestedImage));
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
  if (!(await pullImage(command, fallbackImage))) {
    throw new Error(`Fallback sandbox image failed to pull: ${fallbackImage}`);
  }
  exportImage(await repoDigestOf(command, fallbackImage));
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
