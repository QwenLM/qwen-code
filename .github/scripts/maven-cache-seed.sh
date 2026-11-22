#!/usr/bin/env bash
# shellcheck shell=bash
# The caller sets repo to the disposable job-local Maven repository.
# shellcheck disable=SC2154 # repo is assigned by every sourcing caller.
# The host-copy attempt is best-effort, but reconstructing a safe local
# directory must succeed before Maven uses it. It takes no lock.

# Never follow a repository alias into state outside this job.
# Quarantine the disposable prior tree before Maven writes, so nested
# directory aliases cannot redirect a subsequent cp or Maven write.
if [ -L "${repo}" ]; then
  unlink "${repo}"
fi

# Repair only quarantine directories, never potentially host-linked files.
# Neither a failed repair nor an unreadable tree is reclaimed.
# findmnt canonicalizes targets. Parse JSON, then normalize only the caller
# path; other mount targets may be unreadable to this job.
seed_mount_guard() {
  local kernel_name mount_table
  kernel_name="$(uname -s)" || return "$?"
  [ "${kernel_name}" = "Linux" ] || return 0
  command -v findmnt >/dev/null 2>&1 || return 1
  command -v node >/dev/null 2>&1 || return 1
  mount_table="$(findmnt -J -n -o TARGET)" || return "$?"
  printf '%s\n' "${mount_table}" | node --input-type=commonjs -e '
    const fs = require("node:fs");
    const root = fs.realpathSync.native(process.argv[1]);
    const prefix = root === "/" ? "/" : root + "/";
    const pending = JSON.parse(fs.readFileSync(0, "utf8")).filesystems;
    while (pending.length > 0) {
      const entry = pending.pop();
      const target = entry.target;
      if (target === root || target.startsWith(prefix)) {
        process.exitCode = 1;
      }
      pending.push(...(entry.children ?? []));
    }
  ' "$1"
}

# Repair only quarantine directories, never potentially host-linked files.
# Neither a failed repair nor an unreadable tree is reclaimed.
seed_remove_quarantine() {
  local unrepairable
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    rm -f -- "$1"
    return "$?"
  fi
  seed_mount_guard "$1" || return "$?"
  unrepairable="$(find -P "$1" -xdev -type d ! -perm -u=rwx ! -exec chmod u+rwx {} \; -print -quit)" || return "$?"
  [ -z "${unrepairable}" ] || return 1
  if rm --help 2>/dev/null | grep -q -- '--one-file-system'; then
    rm -rf --one-file-system -- "$1"
  else
    find -P "$1" -xdev -mindepth 1 -delete && rmdir "$1"
  fi
}

# Retry any reclaimed prior-job quarantine before allocating another.
# If it cannot be reclaimed, stop rather than accumulating trees.
for seed_previous_stale_repo in "${RUNNER_TEMP}"/m2-repo.stale.*; do
  if [ -e "${seed_previous_stale_repo}" ] || [ -L "${seed_previous_stale_repo}" ]; then
    seed_remove_quarantine "${seed_previous_stale_repo}" || {
      echo "::error::Previous Maven cache quarantine could not be reclaimed: ${seed_previous_stale_repo}"
      exit 1
    }
  fi
done

seed_stale_repo=""
if [ -e "${repo}" ]; then
  seed_stale_repo="$(mktemp -d "${RUNNER_TEMP}/m2-repo.stale.XXXXXX")" || exit 1
  rmdir "${seed_stale_repo}"
  mv "${repo}" "${seed_stale_repo}" || exit 1
fi
mkdir -p "${repo}"
if [ -d "${HOME}/.m2/repository" ]; then
  seed_source_device="$(stat -Lc '%d' "${HOME}/.m2/repository" || true)"
  seed_job_device="$(stat -Lc '%d' "${repo}" || true)"
  seed_cold_start=0
  if [ -n "${seed_source_device}" ] && [ "${seed_source_device}" = "${seed_job_device}" ]; then
    # A source-side mount does not survive as a mount in the hardlinked
    # destination, but its files would still alias host state. Skip the
    # optional copy unless the source tree is safely inspectable.
    if seed_mount_guard "${HOME}/.m2/repository"; then
      # Device IDs are only a pre-check. Any failed copy also needs a
      # cold start, because its partial tree is not safe for Maven.
      cp -aln "${HOME}/.m2/repository/." "${repo}" || {
        seed_cold_start=$?
        echo "::warning::Maven cache seed failed (cp exit ${seed_cold_start}); this leg will resolve Maven dependencies from the network"
      }
    else
      seed_cold_start=1
      echo "::warning::Maven cache seed skipped: host cache mount boundaries are unsafe or uninspectable; using a clean job-local repository"
    fi
  else
    seed_cold_start=1
  fi
  # Directory modes may have been inherited through cp -a. Repair
  # only job-local directories, never potentially hardlinked files.
  # Capture a failed directory instead of relying on find's status:
  # it ignores failed -exec commands, and no marker I/O can hide them.
  seed_mount_guard "${repo}" || {
    echo '::error::Maven cache contains a mount or its filesystem boundaries could not be inspected'
    exit 1
  }
  chmod u+rwx "${repo}" || exit 1
  seed_unrepairable_directory="$(find -P "${repo}" -xdev -type d ! -perm -u=rwx ! -exec chmod u+rwx {} \; -print -quit)" || exit 1
  if [ -n "${seed_unrepairable_directory}" ]; then
    echo "::error::Maven cache directory permissions could not be repaired: ${seed_unrepairable_directory}"
    exit 1
  fi
  find -P "${repo}" -xdev -type l -delete || exit 1
  if [ "${seed_cold_start}" -ne 0 ]; then
    # A failed cleanup cannot be reported as a clean job-local cache.
    find -P "${repo}" -xdev -mindepth 1 -delete || exit 1
    if [ -z "${seed_source_device}" ] || [ "${seed_source_device}" != "${seed_job_device}" ]; then
      echo "::warning::Maven cache seed skipped: hard links are unavailable between the host and job-local repositories; using a clean job-local repository"
    else
      echo "::notice::Retrying Maven using a clean job-local repository"
    fi
  fi
fi
if [ -n "${seed_stale_repo}" ]; then
  seed_remove_quarantine "${seed_stale_repo}" || echo "::warning::Previous job-local Maven cache was left in quarantine at ${seed_stale_repo}"
fi

# Drop resolver tracking markers, version metadata and checksums,
# *.tmp transfer files, and older Resolver *.part / *.part.lock
# residue. Unlocked runs must not inherit mutable resolver state;
# Maven recreates them job-locally. A partially cleaned tree must
# not reach Maven: surviving links could still mutate the host cache.
if [ -d "${repo}" ]; then
  find -P "${repo}" -xdev ! -type d \( -name '*.lastUpdated' -o -name 'resolver-status.properties' -o -name '_remote.repositories' -o -name 'maven-metadata-*.xml*' -o -name '*.part' -o -name '*.part.lock' -o -name '*.tmp' \) -delete || exit 1
  # Both in-house coordinates are fixed release versions this job
  # builds locally, so a seeded copy is only a hardlink the unlocked
  # Maven runs would rewrite through into the host cache. Drop them
  # at any depth, including the legacy nested tree, so the install
  # writes fresh inodes.
  find -P "${repo}" -xdev -depth \
    \( -path '*/com/alibaba/qwencode-sdk' -o -path '*/com/alibaba/qwencode-sdk/*' -o -path '*/com/alibaba/qwen-managed-agent-*' -o -path '*/com/alibaba/qwen-managed-agent-*/*' \) \
    -delete || exit 1
fi
