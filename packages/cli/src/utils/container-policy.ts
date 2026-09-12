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

// Preserve the established review sandbox HOME path for both consumers.
export const CONTAINER_HOME = '/qwen-review-home';

/** Only these explicit values reach review commands and subagent workers. */
export function containerEnv(cacheDir: string): string[] {
  return [
    'CI=1',
    'npm_config_yes=true',
    'QWEN_SKIP_PREPARE=1',
    // A mapped uid needs a writable HOME. A fresh tmpfs also prevents a
    // previous run's .profile or .npmrc from influencing a later install.
    `HOME=${CONTAINER_HOME}`,
    // The caller owns cache lifetime: review uses its persistent mount;
    // per-agent installation uses a disposable cache inside the HOME tmpfs.
    // npm verifies cached package integrity when reusing the review cache.
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
 * treated as trusted execution evidence. An operator's own `DOCKER_HOST`
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
