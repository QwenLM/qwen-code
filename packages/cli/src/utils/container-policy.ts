/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The whole `info` document is searched rather than one schema path, because
 * the two runtimes spell this in unrelated places — docker as a
 * `SecurityOptions` entry, podman as `Host.Security.Rootless` — and a
 * per-runtime template that a version rename breaks would fail to the rootful
 * answer without saying so. Verified against a live rootful docker: the word
 * does not occur anywhere in its `info` document, so a marker hit is a
 * positive statement, not an accident of some unrelated field.
 */
export function hasRootlessMarker(info: string): boolean {
  return (
    info.includes('"name=rootless"') ||
    info.includes('"rootless":true') ||
    info.includes('"Rootless":true')
  );
}

/**
 * The environment the PR's code is given inside the container.
 *
 * An allowlist rather than the inherited environment, which is the point:
 * today both call sites hand it `process.env`, and on CI that carries the
 * review's model and GitHub credentials. `CI` and the npm knobs are the ones
 * the pipeline sets on purpose (`buildRunEnv`), so they are the ones that
 * cross.
 */
export const CONTAINER_HOME = '/qwen-review-home';

export function containerEnv(cacheDir: string): string[] {
  return [
    'CI=1',
    'npm_config_yes=true',
    'QWEN_SKIP_PREPARE=1',
    // `HOME` explicitly, because forcing a uid resets it to `/` in these
    // images — `utils/sandbox.ts` copies the host's for the same reason — and
    // `/` is not writable by the mapped user, so npm's first write fails
    // before the install starts.
    //
    // And it points at a TMPFS, not at the mount. The first cut put it under
    // the mount and shared it across every command of every tree: `sh -lc` is
    // a login shell that sources `$HOME/.profile`, and npm reads
    // `$HOME/.npmrc`, so one run's postinstall could plant both and the NEXT
    // review's install — network on — would source and read them. That is
    // cross-run execution wearing this module's own `--rm` "isolation by
    // construction" claim, and it was introduced by the fix for the `$HOME`
    // problem rather than found in the original. A tmpfs is discarded with the
    // container and never touches the host, so the claim is true again.
    `HOME=${CONTAINER_HOME}`,
    // The npm cache stays on the mount, deliberately: it is what keeps an
    // install from re-downloading ~1 700 packages every review, it holds no
    // rc file or profile, and npm verifies each entry's integrity hash on
    // read. That verification is what stands between a poisoned cache and a
    // bad install — worth naming rather than implying the cache is inert.
    `npm_config_cache=${cacheDir}`,
  ];
}

/**
 * The environment the container RUNTIME CLIENT is spawned with.
 *
 * `DOCKER_HOST` and its TLS companions decide which daemon answers — so a
 * repository that ships one in `.qwen/.env` points both the availability probe
 * and every `docker run` at a daemon it controls: `required` reads as
 * satisfied, the mount is handed over, and whatever that daemon returns is
 * scored as build, test and probe evidence. An operator's own `DOCKER_HOST`
 * (a remote engine, colima, rootless) is untouched — only the file-sourced
 * ones are dropped.
 */
export function trustedProcessEnv(
  env: NodeJS.ProcessEnv,
  isFileSourcedEnvKey: (key: string) => boolean,
): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  // EVERY file-sourced key, not a list of the dangerous ones.
  //
  // The list was the first design and it lost twice: it named the daemon
  // selectors and missed the proxy family, then named those and missed
  // `DOCKER_API_VERSION` — a value that does not select a daemon at all, it
  // just makes every call to one fail, which under `auto` turns containment
  // off silently because the availability probe reads a broken client as "no
  // runtime". The class is not "variables that point somewhere else", it is
  // "variables a repository can set that change what this client does", and
  // that has no last entry: an incompatible API version, a proxy, a config
  // path, a `PATH` naming a different `docker` binary.
  //
  // The client does not need repository-provided environment for anything. So
  // the rule is provenance, not name: what the loader wrote from a file the
  // reviewed checkout supplies does not reach the process that decides whether
  // containment happened.
  //
  // Deleting is the right restore, not an approximation of one: the loader
  // records a key as file-sourced only where the real environment had nothing
  // (`isEffectivelyUnset` in config/environment.ts), so a file value never
  // shadows an inherited one and dropping it returns the variable to exactly
  // its pre-load state. The scrub therefore cannot cost the client a `PATH` or
  // `HOME` from the operator's shell — those are set, so they are never
  // file-sourced. What it does cost is a value the operator kept ONLY in a
  // `.env`, which `isFileSourcedEnvKey` cannot tell from the repository's own;
  // that one must move to their shell. Conservative on the right side.
  for (const key of Object.keys(scrubbed)) {
    if (isFileSourcedEnvKey(key)) delete scrubbed[key];
  }
  return scrubbed;
}
