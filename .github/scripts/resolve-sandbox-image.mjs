#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const GHCR_REPOSITORY = 'qwenlm/qwen-code';

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
  );
  if (!tokenResponse.ok) {
    throw new Error(`Failed to fetch GHCR token: ${tokenResponse.status}`);
  }

  const { token } = await tokenResponse.json();
  const tagsResponse = await fetch(
    `https://ghcr.io/v2/${GHCR_REPOSITORY}/tags/list?n=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!tagsResponse.ok) {
    throw new Error(`Failed to fetch GHCR tags: ${tagsResponse.status}`);
  }

  const { tags = [] } = await tagsResponse.json();
  const latest = latestSemverTag(tags);
  if (!latest) {
    throw new Error('No semver GHCR tags found for qwen-code.');
  }
  return latest;
}

function pullImage(command, image) {
  return new Promise((resolve) => {
    const child = spawn(command, ['pull', image], { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
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
    `Falling back from ${requestedImage} to latest GHCR semver ${fallbackImage}`,
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
