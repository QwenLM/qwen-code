#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
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

// Pin the daemon endpoint for every spawn below. The docker CLI resolves its
// endpoint in precedence order DOCKER_HOST, --context, DOCKER_CONTEXT, and
// finally `currentContext` in $DOCKER_CONFIG/config.json — a file shared by
// every runner registration on the self-hosted pool. Clearing DOCKER_CONTEXT
// is not enough: an empty value falls through to currentContext, so a
// co-resident process that rewrites config.json (or sets DOCKER_HOST through
// $GITHUB_ENV) can point the pull and the inspect at a daemon it controls and
// hand back whatever digest it likes. Name the context explicitly and drop
// DOCKER_HOST, so nothing above `default` in that order is reachable. There is
// deliberately no env override: a variable that selects the endpoint would be
// settable through the same channel this closes. DOCKER_CONFIG is left alone —
// it carries the registry credentials the pull needs.
export function sandboxSpawnEnv(env = process.env) {
  const childEnv = { ...env, DOCKER_CONTEXT: 'default' };
  delete childEnv.DOCKER_HOST;
  return childEnv;
}

// $GITHUB_ENV and $GITHUB_OUTPUT are runner-managed files under $RUNNER_TEMP,
// which on the shared pool is writable by anything running at the runner's
// uid. A plain append opens whatever sits at that path: a planted FIFO with no
// reader blocks open(2) until the step timeout, turning one line of writable
// state into a per-round hang. O_NONBLOCK makes that case an immediate ENXIO,
// and the post-open fstat refuses every non-regular file — the type check, not
// the path, is what holds. O_NOFOLLOW is deliberately not set: the runner may
// legitimately place these files behind a symlinked temp directory.
export function appendStepFile(file, line) {
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NONBLOCK,
      0o600,
    );
    if (!fstatSync(fd).isFile()) {
      throw new Error(
        `${file} is not a regular file; refusing to write step state to it.`,
      );
    }
    // writeSync can come up short on a signal; appendFileSync loops for us
    // and this does not, so drain the buffer explicitly rather than shipping
    // a truncated `image=` line that a consumer would read as a valid one.
    const payload = Buffer.from(line, 'utf8');
    for (let written = 0; written < payload.length; ) {
      written += writeSync(fd, payload, written, payload.length - written);
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// The `Digest: sha256:…` line docker prints for the tag it just resolved is
// the only pull-time content identity: the post-pull inspect can race a
// `docker tag` swap (see repoDigestOf), so the exported reference must be
// bound to what the pull itself reported, never to inspect alone.
export function parsePullDigest(pullOutput) {
  return pullOutput.match(/^Digest: (sha256:[0-9a-f]{64})\s*$/m)?.[1] ?? '';
}

// The spawn guard lives in ONE place: the endpoint pin, the settle-once
// finish, the SIGKILL timer, the stdout accumulation, and the error/close
// wiring. The pull and the inspect used to carry near-verbatim copies that
// had already drifted (#9527 review) — a fix to any of those paths must
// reach every docker invocation, and no future caller can drop the pin.
function spawnDockerCapture(command, args, { timeoutMs, label, onChunk }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: sandboxSpawnEnv(),
    });
    let stdout = '';
    let settled = false;
    let timer;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout });
    };
    timer = setTimeout(() => {
      console.error(`::error::Timed out ${label} after ${timeoutMs / 1000}s.`);
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onChunk?.(chunk);
    });
    child.on('error', (error) => {
      console.error(
        `::error::Failed to start '${command} ${args.join(' ')}': ${error.message}`,
      );
      finish(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(
          `::error::'${command} ${args.join(' ')}' exited with code ${code}.`,
        );
      }
      finish(code);
    });
  });
}

export function pullImage(command, image, timeoutMs = PULL_TIMEOUT_MS) {
  return spawnDockerCapture(command, ['pull', image], {
    timeoutMs,
    label: `pulling ${image}`,
    onChunk: (chunk) => process.stdout.write(chunk),
  }).then(({ exitCode, stdout }) =>
    exitCode === 0
      ? { ok: true, digest: parsePullDigest(stdout) }
      : { ok: false, digest: '' },
  );
}

// The repository part of an image reference: everything before the :tag /
// @digest. A registry port keeps its colon — the tag only ever follows the
// LAST '/'.
export function repoOfImage(image) {
  const withoutDigest = image.split('@')[0];
  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  return lastColon > lastSlash
    ? withoutDigest.slice(0, lastColon)
    : withoutDigest;
}

// Resolve a PULLED image to its content digest (repo@sha256:…). The tag
// alone is a mutable local handle: `docker run <tag>` resolves against the
// local store without re-pull, and a co-resident process with daemon access
// can `docker tag` different content under the same name between resolve
// and gate. A digest reference cannot be moved by `docker tag`/`docker build`.
// The export must be the EXACT `<repo>@<expectedDigest>` RepoDigests entry:
// RepoDigests is shared by every tag of the same content, so `docker tag`
// of the pulled image adds an alphabetically-sorted entry for the new name
// and index 0 can move OFF the pulled repo (a suffix-only digest check
// still passes) — and retagged attacker content keeps ITS original repo, so
// only the pulled repo + the pull's own `Digest:` line together bind the
// export to the content the pull fetched (#9214 review).
export function repoDigestOf(
  command,
  image,
  expectedDigest,
  timeoutMs = FETCH_TIMEOUT_MS,
) {
  return spawnDockerCapture(
    command,
    ['image', 'inspect', '--format', '{{json .RepoDigests}}', image],
    { timeoutMs, label: `inspecting ${image}` },
  )
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.trim() : ''))
    .then((raw) => {
      // `null`/`[]` (no RepoDigests, a locally built image), `<no value>` and
      // empty (the inspect failed) all mean there is no repository digest —
      // the mutable tag is exactly what must not be exported.
      let digests = [];
      try {
        const parsed = JSON.parse(raw.trim());
        if (Array.isArray(parsed)) {
          digests = parsed.filter((entry) => typeof entry === 'string');
        }
      } catch {
        // Non-JSON output carries no digests.
      }
      // Docker records Hub repos in canonical short form in RepoDigests —
      // `docker.io/library/busybox` is stored as `busybox@sha256:…` — so fold
      // those prefixes before matching, or a fully-qualified Hub reference
      // fails closed on its own correct digest.
      const repo = repoOfImage(image).replace(/^docker\.io\/(library\/)?/, '');
      const digest =
        digests.find((entry) => entry === `${repo}@${expectedDigest}`) ?? '';
      if (digest.includes('@sha256:')) {
        return digest;
      }
      if (digests.length > 0) {
        throw new Error(
          `Pulled image ${image} resolved to digests none of which is '${repo}@${expectedDigest}' (${digests.join(', ')}); refusing to export a foreign or mutable reference.`,
        );
      }
      throw new Error(
        `Pulled image ${image} resolved to no repository digest ('${raw.trim()}'); refusing to export a mutable tag.`,
      );
    });
}

export function exportImage(image) {
  if (process.env.GITHUB_ENV) {
    appendStepFile(process.env.GITHUB_ENV, `QWEN_SANDBOX_IMAGE=${image}\n`);
  }
  // Also as a step OUTPUT: $GITHUB_ENV is a file later steps can append to,
  // so a consumer that must not be steered by branch code (the verification
  // gate's container image) reads the expression-context value instead.
  if (process.env.GITHUB_OUTPUT) {
    appendStepFile(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  }
  console.log(`QWEN_SANDBOX_IMAGE=${image}`);
}

// The refusal policy is the same for both export paths: no `Digest:` line
// from the pull means nothing binds the export to the pulled content.
async function exportDigestBoundImage(command, image, pull) {
  if (!pull.digest) {
    throw new Error(
      `'${command} pull ${image}' reported no Digest line; refusing to export an unbound image reference.`,
    );
  }
  exportImage(await repoDigestOf(command, image, pull.digest));
}

async function main() {
  const requestedImage = validateRequestedImage(process.argv[2]);

  const command = process.env.SANDBOX_COMMAND || 'docker';
  const requestedPull = await pullImage(command, requestedImage);
  if (requestedPull.ok) {
    await exportDigestBoundImage(command, requestedImage, requestedPull);
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
  await exportDigestBoundImage(command, fallbackImage, fallbackPull);
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
