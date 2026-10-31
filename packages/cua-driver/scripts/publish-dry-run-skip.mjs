// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

// A publish dry-run queries the live registry, so it fails whenever the
// packaged version already exists there (registry state after a release,
// not a packaging defect). Only that exact collision is tolerable; every
// other failure (auth, network, tarball content) must keep failing.
const ALREADY_PUBLISHED_PATTERN =
  /You cannot publish over the previously published versions/u

export function isAlreadyPublishedDryRunFailure(text) {
  return ALREADY_PUBLISHED_PATTERN.test(text)
}
