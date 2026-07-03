#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const GHCR_REPOSITORY = 'qwenlm/qwen-code';
const FETCH_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

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

async function fetchLatestGhcrSemver() {
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${GHCR_REPOSITORY}:pull`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Failed to fetch GHCR token: ${tokenResponse.status}`);
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
    throw new Error(`Failed to fetch GHCR tags: ${tagsResponse.status}`);
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
        `Timed out pulling ${image} after ${PULL_TIMEOUT_MS / 1000}s.`,
      );
      child.kill('SIGKILL');
      finish(false);
    }, PULL_TIMEOUT_MS);

    child.on('error', (error) => {
      console.error(
        `Failed to start '${command} pull ${image}': ${error.message}`,
      );
      finish(false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`'${command} pull ${image}' exited with code ${code}.`);
      }
      finish(code === 0);
    });
  });
}

function exportImage(image) {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `QWEN_SANDBOX_IMAGE=${image}\n`);
  }
  console.log(`QWEN_SANDBOX_IMAGE=${image}`);
}

async function main() {
  const requestedImage = process.argv[2];
  if (!requestedImage) {
    throw new Error('Usage: resolve-sandbox-image.mjs <image>');
  }

  const command = process.env.SANDBOX_COMMAND || 'docker';
  if (await pullImage(command, requestedImage)) {
    exportImage(requestedImage);
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
  exportImage(fallbackImage);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
