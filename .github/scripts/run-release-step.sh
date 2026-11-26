#!/usr/bin/env bash
# Fail closed like the sibling runners in this directory. Without pipefail a
# connection-level `gh` failure inside a `gh ... | jq ...` substitution reads as
# an empty result (jq exits 0 on empty input), which sent notify-failure down
# its create-a-new-issue branch and past all three issue-reuse guards.
# Per-command failures stay tolerated: every `|| ...` below attaches to a whole
# command rather than to a pipeline leg, so it keeps working under pipefail.
set -eo pipefail

step="${1:?usage: run-release-step.sh <step>}"

commit_release_version() {
  git add package.json pnpm-lock.yaml packages/*/package.json packages/channels/*/package.json integrations/*/package.json integrations/*/qwen-extension.json
  if git diff --staged --quiet; then
    echo "No version changes to commit"
  else
    git commit -m "chore(release): ${RELEASE_TAG}"
  fi
}

publish_package() {
  local directory="$1"
  (
    cd "${directory}"
    local package_name
    local -a publish_args
    package_name="$(node -p "require('./package.json').name")"
    publish_args=(--access public "--tag=${NPM_TAG}")
    if [[ "${IS_DRY_RUN}" == "true" ]]; then
      publish_args+=(--dry-run)
    elif npm view "${package_name}@${RELEASE_VERSION}" version >/dev/null 2>&1; then
      echo "::notice::${package_name}@${RELEASE_VERSION} already published; skipping"
      exit 0
    fi
    # npm, not pnpm: pnpm's packer writes 0644 for every entry outside `bin`, so
    # the generated CLI's `vendor/ripgrep/*/rg` lost the exec bit that
    # copy_bundle_assets.js restores on purpose — a fresh install then could not
    # spawn the bundled ripgrep at all (#12668). npm keeps the working-tree mode.
    # Only this generated package needs it; the workspace loop stays on pnpm.
    npm publish --provenance "${publish_args[@]}"
  )
}

case "${step}" in
  set-flags)
    release_is_nightly="false"
    if [[ "${CRON}" == "0 21 * * *" || "${CREATE_NIGHTLY_RELEASE}" == "true" ]]; then
      release_is_nightly="true"
    fi
    echo "is_nightly=${release_is_nightly}" >> "${GITHUB_OUTPUT}"

    release_is_preview="false"
    if [[ "${CRON}" == "0 17 * * 2" || "${CREATE_PREVIEW_RELEASE}" == "true" ]]; then
      release_is_preview="true"
    fi
    echo "is_preview=${release_is_preview}" >> "${GITHUB_OUTPUT}"

    release_is_dry_run="false"
    if [[ "${DRY_RUN_INPUT}" == "true" ]]; then
      release_is_dry_run="true"
    fi
    echo "is_dry_run=${release_is_dry_run}" >> "${GITHUB_OUTPUT}"
    ;;

  resolve-commit)
    echo "release_sha=$(git rev-parse HEAD)" >> "${GITHUB_OUTPUT}"
    ;;

  resolve-version)
    if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null || true)" == "true" ]]; then
      for attempt in 1 2 3; do
        if git fetch --depth=1 --filter=tree:0 --no-tags origin '+refs/tags/v*:refs/tags/v*'; then
          break
        fi
        if [[ "${attempt}" -eq 3 ]]; then
          echo "::error::Failed to fetch version tags for release version resolution."
          exit 1
        fi
        sleep 2
      done
    fi

    version_args=()
    if [[ "${IS_NIGHTLY}" == "true" ]]; then
      version_args+=(--type=nightly)
    elif [[ "${IS_PREVIEW}" == "true" ]]; then
      version_args+=(--type=preview)
      if [[ -n "${MANUAL_VERSION}" ]]; then
        manual_clean="${MANUAL_VERSION#v}"
        if [[ "${manual_clean}" =~ ^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+$ ]]; then
          version_args+=("--preview_version_override=${manual_clean}")
        elif [[ "${manual_clean}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
          version_args+=("--preview_version_override=${manual_clean}-preview.0")
        else
          echo "::error::For preview releases, version must be X.Y.Z or X.Y.Z-preview.N; got ${MANUAL_VERSION}"
          exit 1
        fi
      fi
    else
      version_args+=(--type=stable)
      if [[ -n "${MANUAL_VERSION}" ]]; then
        version_args+=("--stable_version_override=${MANUAL_VERSION}")
      fi
    fi

    version_json=$(node scripts/get-release-version.js "${version_args[@]}")
    echo "RELEASE_TAG=$(echo "$version_json" | jq -r .releaseTag)" >> "$GITHUB_OUTPUT"
    echo "RELEASE_VERSION=$(echo "$version_json" | jq -r .releaseVersion)" >> "$GITHUB_OUTPUT"
    echo "NPM_TAG=$(echo "$version_json" | jq -r .npmTag)" >> "$GITHUB_OUTPUT"
    echo "PREVIOUS_RELEASE_TAG=$(echo "$version_json" | jq -r .previousReleaseTag)" >> "$GITHUB_OUTPUT"
    ;;

  pack-build)
    build_paths=('dist' 'packages/web-templates/src/generated')
    while IFS= read -r -d '' path; do
      build_paths+=("${path}")
    done < <(find packages integrations -type d -name node_modules -prune -o -type d -name dist -prune -print0)
    printf '%s\n' "${build_paths[@]}"
    [[ ${#build_paths[@]} -gt 2 ]] || {
      echo "::error::Pack Build Outputs found no build outputs beyond the hardcoded paths."
      exit 1
    }
    tar -czf "${RUNNER_TEMP}/release-build.tgz" "${build_paths[@]}"
    ;;

  verify-package)
    npm run bundle
    test -f dist/review-sources.sha256 || {
      echo "::error::review source stamp missing — see the copy_bundle_assets warning above"
      exit 1
    }
    npm run prepare:package
    ;;

  prepare-release-branch)
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git config core.hooksPath .husky

    release_branch_name="release/${RELEASE_TAG}"
    git switch -c "${release_branch_name}"
    echo "BRANCH_NAME=${release_branch_name}" >> "${GITHUB_OUTPUT}"
    npm run release:version "${RELEASE_VERSION}"
    ;;

  commit-release-branch)
    commit_release_version
    ;;

  pack-release)
    handoff="${RUNNER_TEMP:?}/release-publish-build"
    rm -rf -- "$handoff"
    mkdir -p "$handoff"
    "$0" pack-build
    mv "${RUNNER_TEMP}/release-build.tgz" "$handoff/"
    tar -czf "$handoff/audio-prebuilds.tgz" packages/audio-capture/prebuilds
    release_commit="$(git rev-parse HEAD)"
    if [[ "$release_commit" != "${RELEASE_SHA:?}" ]]; then
      git bundle create "$handoff/version.bundle" "${RELEASE_SHA}..refs/heads/${BRANCH_NAME:?}"
    fi
    echo "release_commit=$release_commit" >> "${GITHUB_OUTPUT:?}"
    ;;

  restore-release)
    handoff="${RUNNER_TEMP:?}/release-publish-build"
    [[ "${RELEASE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]] || exit 1
    [[ "${RELEASE_SHA:?}" =~ ^[0-9a-f]{40}$ ]] || exit 1
    branch="release/${RELEASE_TAG:?}"
    git check-ref-format "refs/heads/$branch"
    if [[ "$RELEASE_COMMIT" == "$RELEASE_SHA" ]]; then
      git switch -c "$branch" "$RELEASE_SHA"
    else
      git bundle verify "$handoff/version.bundle"
      git fetch "$handoff/version.bundle" "refs/heads/$branch:refs/heads/$branch"
      [[ "$(git rev-parse "$branch")" == "$RELEASE_COMMIT" ]] || exit 1
      [[ "$(git rev-list --parents -n 1 "$RELEASE_COMMIT")" == "$RELEASE_COMMIT $RELEASE_SHA" ]] || exit 1
      git switch "$branch"
    fi
    tar -xzf "$handoff/release-build.tgz"
    tar -xzf "$handoff/audio-prebuilds.tgz"
    test -s dist/cli.js
    test -s dist/review-sources.sha256
    ;;

  push-release-branch)
    release_branch_name="${BRANCH_NAME:?}"
    commit_release_version
    if [[ "${IS_DRY_RUN}" == "false" ]]; then
      # A release branch left behind by an earlier attempt means this version
      # may be partially published. Resume it instead of force-pushing over
      # it: when the regenerated tree matches the branch tip, reuse that
      # commit so the publish step can skip already-published packages and
      # ship the rest. A divergent tree is a different release under the same
      # version and stays refused. This restores the retry semantics the
      # push-time "already shipped" guard (#9076) accidentally killed: it ran
      # before publish and failed any rerun whose first attempt had already
      # pushed the branch, so the per-package skip never got to run.
      remote_branch="$(git ls-remote --heads origin "refs/heads/${release_branch_name}")"
      if [[ -n "${remote_branch}" ]]; then
        # Read-only probes only, ahead of the write-credential export; the
        # channel guard's code rides the workflow-pinned checkout.
        if [[ -z "${RELEASE_SHA:-}" ]]; then
          echo "::error::RELEASE_SHA is not set; refusing to resume an existing release branch without provenance."
          exit 1
        fi
        git fetch --no-tags origin "refs/heads/${release_branch_name}"
        release_commit="$(git rev-parse FETCH_HEAD)"
        # A completed release outranks every other refusal, including the
        # finalize CHANGELOG commit that advanced the branch after shipping.
        if release_state="$(gh release view "${RELEASE_TAG}" --json isDraft --jq '.isDraft' 2>&1)"; then
          if [[ "${release_state}" == "false" ]]; then
            echo "::notice::Release ${RELEASE_TAG} is already published; nothing to resume."
            echo "version_refusal=true" >> "${GITHUB_OUTPUT}"
            exit 1
          fi
        elif ! echo "${release_state}" | grep -qi 'not found'; then
          echo "::error::Cannot confirm GitHub Release ${RELEASE_TAG} state: ${release_state}"
          exit 1
        fi
        # Same parentage restore-release enforces: the source itself (no
        # bump needed) or a single-parent bump commit on it; merges fail.
        if [[ "${release_commit}" != "${RELEASE_SHA}" ]] &&
          [[ "$(git rev-list --parents -n 1 "${release_commit}")" != "${release_commit} ${RELEASE_SHA}" ]]; then
          echo "::error::${release_branch_name} tip ${release_commit} is not the release source ${RELEASE_SHA} or its direct single-parent version commit. Refusing to resume."
          exit 1
        fi
        if [[ "$(git rev-parse 'HEAD^{tree}')" != "$(git rev-parse "${release_commit}^{tree}")" ]]; then
          echo "::error::${release_branch_name} already exists with different contents. Resume from that release commit instead."
          echo "version_refusal=true" >> "${GITHUB_OUTPUT}"
          exit 1
        fi
        # gh release create ignores --target for an existing tag, so a tag
        # on another commit would split npm and the Release across commits.
        remote_tag="$(git ls-remote origin "refs/tags/${RELEASE_TAG}" "refs/tags/${RELEASE_TAG}^{}")"
        if [[ -n "${remote_tag}" ]]; then
          # Prefer the peeled commit of an annotated tag; else the ref itself.
          tag_commit="$(printf '%s\n' "${remote_tag}" | awk '/\^\{\}$/{sha=$1} END{if(!sha) sha=$1; print sha}')"
          if [[ "${tag_commit}" != "${release_commit}" ]]; then
            echo "::error::Remote tag ${RELEASE_TAG} points at ${tag_commit}, not the release commit ${release_commit}. Refusing to resume."
            exit 1
          fi
        fi
        # Same exit-code contract as the pre-push guard below: only 2 retries.
        for attempt in 1 2 3; do
          channel_status=0
          node .release-workflow/scripts/assert-release-version.mjs --assert-channel-resumable --version="${RELEASE_VERSION}" --tag="${NPM_TAG}" || channel_status=$?
          if [[ "${channel_status}" -ne 2 ]]; then
            break
          fi
          if [[ "${attempt}" -lt 3 ]]; then
            echo "Resume channel probe failed (exit 2); retrying in $(( attempt * 15 ))s (attempt ${attempt} of 3)..."
            sleep $(( attempt * 15 ))
          fi
        done
        if [[ "${channel_status}" -eq 1 ]]; then
          echo "version_refusal=true" >> "${GITHUB_OUTPUT}"
          exit 1
        fi
        if [[ "${channel_status}" -ne 0 ]]; then
          exit "${channel_status}"
        fi
        # -C overwrites the restored handoff's stale same-name branch so the
        # rebuild below builds the adopted commit.
        git switch -C "${release_branch_name}" "${release_commit}"
        echo "reused_commit=true" >> "${GITHUB_OUTPUT}"
        echo "::notice::Reusing ${release_branch_name} at ${release_commit}; published npm versions will be skipped."
        exit 0
      fi
      # Keep the write credential unavailable until the push step needs it.
      export GH_TOKEN="${CI_BOT_PAT}"
      gh auth setup-git
      # Guard exit codes: 0 unreleased, 2 probe failure (the only retryable
      # one), 3 already shipped, 4 malformed version. Anything but 2 breaks
      # out on the first attempt so a decisive refusal is not logged three
      # times as a connectivity problem.
      for attempt in 1 2 3; do
        guard_status=0
        node .release-workflow/scripts/assert-release-version.mjs --assert-unreleased="${RELEASE_VERSION}" || guard_status=$?
        if [[ "${guard_status}" -ne 2 ]]; then
          break
        fi
        if [[ "${attempt}" -lt 3 ]]; then
          echo "Push-time guard probe failed (exit 2); retrying in $(( attempt * 15 ))s (attempt ${attempt} of 3)..."
          sleep $(( attempt * 15 ))
        fi
      done
      if [[ "${guard_status}" -eq 3 ]]; then
        echo "version_refusal=true" >> "${GITHUB_OUTPUT}"
        exit 1
      fi
      if [[ "${guard_status}" -ne 0 ]]; then
        exit "${guard_status}"
      fi
      echo "Pushing release branch to remote..."
      git push --set-upstream origin "${release_branch_name}" --follow-tags
    else
      echo "Dry run enabled. Skipping push."
    fi
    ;;

  build-package)
    npm run build
    npm run bundle
    test -f dist/review-sources.sha256 || {
      echo "::error::review source stamp missing — see the copy_bundle_assets warning above"
      exit 1
    }
    npm run prepare:package
    # Last check before the publish step: the tarball the registry will serve
    # must carry the exec bit on every spawned vendored binary (#12668). The gate
    # rides the workflow-pinned checkout, not the selected release ref, which may
    # predate it; `dist` still resolves against the release ref's package.
    node .release-workflow/scripts/check-release-tarball-exec-bits.mjs dist
    ;;

  build-archives)
    preview_args=""
    if [[ "${OPENTUI_PREVIEW_RELEASE_ENABLED}" == "true" ]]; then
      preview_args="--include-opentui-preview"
    fi
    npm run package:standalone:release -- --version "${RELEASE_VERSION}" --out-dir dist/standalone ${preview_args}
    ;;

  publish-packages)
    package_names="$(node "$(dirname "$0")/../../scripts/release-packages.mjs")"
    publish_args=(--access public "--tag=${NPM_TAG}" --no-git-checks --provenance)
    while IFS= read -r name; do
      publish_args+=("--filter=${name}")
    done <<< "${package_names}"
    if [[ "${IS_DRY_RUN}" == "true" ]]; then
      # Exercise packing and lifecycle checks even for an existing version.
      publish_args+=(--dry-run --force)
    fi
    corepack pnpm -r publish "${publish_args[@]}"
    publish_package 'dist'
    ;;

  verify-archives)
    preview_args=""
    if [[ "${OPENTUI_PREVIEW_RELEASE_ENABLED}" == "true" ]]; then
      preview_args="--include-opentui-preview"
    fi
    npm run verify:installation-release -- --dir dist/standalone ${preview_args}
    ;;

  label-release-prs)
    gh label create 'skip-changelog-auto' --repo "${GITHUB_REPOSITORY}" --color 'ededed' --description 'Automatically exclude internal CI changes from release notes' --force
    commits="$(git rev-list "${PREVIOUS_RELEASE_TAG}..HEAD")" || {
      echo "::error::Cannot enumerate commits since ${PREVIOUS_RELEASE_TAG}; skipping auto-labeling."
      exit 1
    }
    while read -r commit; do
      [[ -z "${commit}" ]] && continue
      gh api "repos/${GITHUB_REPOSITORY}/commits/${commit}/pulls" \
        --jq '.[] | select(.merged_at != null) | {number, title, labels}' \
        || echo "::warning::Failed to fetch PRs for commit ${commit}; skipping." >&2
    done <<< "${commits}" | jq -s 'unique_by(.number)' | \
      node .release-workflow/.github/scripts/classify-release-notes.mjs
    ;;

  create-github-release)
    if gh release view "${RELEASE_TAG}" --json isDraft --jq '.isDraft' 2>/dev/null | grep -qx 'false'; then
      echo "::notice::Release ${RELEASE_TAG} already published; skipping creation."
      exit 0
    fi
    prerelease_flag=""
    if [[ "${IS_NIGHTLY}" == "true" || "${IS_PREVIEW}" == "true" ]]; then
      prerelease_flag="--prerelease"
    fi
    notes_args=()
    # Stable release branches are not descendants of the previous release tag.
    if [[ -n "${PREVIOUS_RELEASE_TAG}" ]]; then
      notes_args+=(-f "previous_tag_name=${PREVIOUS_RELEASE_TAG}")
    fi
    notes_file="${RUNNER_TEMP}/release-notes.md"
    generate_notes() {
      gh api --method POST "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
        -f "tag_name=${RELEASE_TAG}" \
        -f "target_commitish=${RELEASE_BRANCH}" \
        "$@" \
        --jq '.body'
    }
    if ! generate_notes "${notes_args[@]}" > "${notes_file}"; then
      echo "::warning::Could not generate notes anchored at ${PREVIOUS_RELEASE_TAG:-<none>}; retrying without an anchor"
      generate_notes > "${notes_file}" || : > "${notes_file}"
    fi
    node .release-workflow/.github/scripts/cap-release-notes.mjs \
      --file "${notes_file}" \
      --tag "${RELEASE_TAG}" \
      --previous-tag "${PREVIOUS_RELEASE_TAG}" \
      --repo "${GITHUB_REPOSITORY}" \
      --server-url "${GITHUB_SERVER_URL}"

    gh release create "${RELEASE_TAG}" \
      dist/cli.js \
      dist/standalone/qwen-code-* \
      dist/standalone/SHA256SUMS \
      --target "${RELEASE_BRANCH}" \
      --title "Release ${RELEASE_TAG}" \
      --notes-file "${notes_file}" \
      ${prerelease_flag}
    ;;

  dispatch-update)
    gh api "repos/${GITHUB_REPOSITORY}/dispatches" \
      --method POST \
      -f 'event_type=npm-published' \
      -f "client_payload[version]=${RELEASE_VERSION}" || {
        echo "::error::npm-published dispatch failed; run the 'Update ECS Runner Qwen' workflow manually."
        exit 1
      }
    ;;

  notify-failure)
    failed_jobs="$(
      for job in \
        "prepare:${PREPARE_RESULT}" \
        "quality:${QUALITY_RESULT}" \
        "integration_none:${INTEGRATION_NONE_RESULT}" \
        "integration_docker:${INTEGRATION_DOCKER_RESULT}" \
        "audio_capture_prebuilds:${AUDIO_PREBUILDS_RESULT}" \
        "build_release:${BUILD_RELEASE_RESULT}" \
        "publish:${PUBLISH_RESULT}"; do
        name="${job%%:*}"
        result="${job#*:}"
        if [[ "${result}" == "failure" ]]; then
          printf -- '- %s\n' "${name}"
        fi
      done
    )"
    if [[ -z "${failed_jobs}" ]]; then
      failed_jobs='- unknown'
    fi

    body_file="$(mktemp)"
    cat > "${body_file}" <<BODY
The release workflow failed.

Release tag: ${RELEASE_TAG}
Run: ${DETAILS_URL}

Failed job(s):
${failed_jobs}
BODY

    # `in:title` is a fuzzy full-text search, so the jq filter re-checks the
    # title exactly: without the trailing " on " a v0.18.1 failure would reuse
    # an open v0.18.10 issue. The bot-authored issue is preferred because the
    # `// .[0]` fallback would otherwise hand a human's same-titled issue to
    # the autofix dispatch below.
    existing_issue="$(
      gh issue list --repo "${GH_REPO}" \
        --state open \
        --search "\"Release Failed for ${RELEASE_TAG}\" in:title" \
        --limit 30 \
        --json number,url,labels,author,title \
      | jq -c --arg tag "${RELEASE_TAG}" \
        '[ .[] | select(.title | startswith("Release Failed for " + $tag + " on ")) ] | (map(select(.author.login == "app/github-actions"))[0] // .[0]) // empty'
    )"
    gh label create "${AUTOFIX_APPROVED_LABEL}" --repo "${GH_REPO}" \
      --description 'Maintainer explicitly approved this issue for autonomous autofix' \
      --color '0e8a16' 2>/dev/null || true
    if [[ -n "${existing_issue}" ]]; then
      issue_number="$(jq -r '.number' <<< "${existing_issue}")"
      issue_url="$(jq -r '.url' <<< "${existing_issue}")"
      issue_author="$(jq -r '.author.login // ""' <<< "${existing_issue}")"
      # Only a workflow-owned issue may be reused: commenting on and
      # labelling a human's issue would attach autofix to someone else's
      # report.
      if [[ "${issue_author}" != "app/github-actions" ]]; then
        echo "::warning::Existing ${issue_url} was opened by ${issue_author:-unknown}; creating a workflow-owned issue instead."
        existing_issue=''
      elif jq -e \
        '(.labels // []) | map(.name) | any(. == "autofix/skip" or . == "autofix/in-progress")' \
        <<< "${existing_issue}" >/dev/null; then
        echo "::warning::Release failed but existing ${issue_url} has an autofix exclusion label; no autofix dispatched."
        exit 0
      else
        gh issue comment "${issue_number}" --repo "${GH_REPO}" --body-file "${body_file}" \
          || echo "::warning::Failed to comment on existing issue #${issue_number}; proceeding with dispatch."
        still_eligible="$(gh issue list --repo "${GH_REPO}" --state open \
          --search "\"Release Failed for ${RELEASE_TAG}\" in:title no:assignee -linked:pr -label:status/need-information -label:status/need-retesting" \
          --json number --jq "any(.[]; .number == ${issue_number})" || echo 'false')"
        # Re-query after commenting: a maintainer who has assigned the issue,
        # linked a PR, or flagged it need-information/need-retesting has taken
        # it over, and autofix must not dispatch onto it. Inverting this test
        # is the failure mode to guard against.
        if [[ "${still_eligible}" != "true" ]]; then
          echo "::warning::Reused ${issue_url} looks maintainer-owned (assignee / linked PR / need-information / need-retesting); skipping autofix dispatch."
          exit 0
        fi
        # Safe to auto-apply approval: release-failure issue content is
        # fully CI-generated, not user-controlled issue text.
        gh issue edit "${issue_number}" --repo "${GH_REPO}" \
          --add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL}" \
          || echo "::warning::Failed to ensure ${BUG_LABEL}/${READY_FOR_AGENT_LABEL}/${AUTOFIX_APPROVED_LABEL} on issue #${issue_number}."
      fi
    fi

    if [[ -z "${existing_issue}" ]]; then
      # Safe to auto-apply approval: release-failure issue content is
      # fully CI-generated, not user-controlled issue text.
      issue_url="$(gh issue create --repo "${GH_REPO}" \
        --title "Release Failed for ${RELEASE_TAG} on $(date -u +'%Y-%m-%d')" \
        --body-file "${body_file}" \
        --label "${BUG_LABEL}" \
        --label "${READY_FOR_AGENT_LABEL}" \
        --label "${AUTOFIX_APPROVED_LABEL}")"
      issue_number="${issue_url##*/}"
    fi

    echo "issue_url=${issue_url}" >> "${GITHUB_OUTPUT:?}"
    echo "Using ${issue_url}; dispatching autofix."
    if ! gh workflow run qwen-autofix.yml --repo "${GH_REPO}" --ref main \
      -f phase=issue \
      -f issue_number="${issue_number}" \
      -f dry_run=false; then
      echo "::warning::Autofix dispatch failed; scheduled autofix can still pick up issue #${issue_number}."
      exit 1
    fi
    ;;

  reconcile-failure)
    # Reached from a success-gated sibling job because notify-failure itself is
    # skipped once a later attempt passes, leaving the issue it filed open for
    # good (#15705). Bot authorship is a hard requirement: a human may have
    # filed the same title to track the flakiness, and closing their issue
    # would discard that follow-up.
    #
    # Shared with the VSCode companion and Chrome extension release workflows
    # (#15840), which file their own issues: they pass FAILURE_TITLE_PREFIX and
    # RELEASE_VERSION because their titles and version outputs differ from
    # release.yml's.
    release_version="${RELEASE_VERSION:-${RELEASE_TAG:-unknown}}"
    title_prefix="${FAILURE_TITLE_PREFIX:-Release Failed for }"
    existing_issues="$(
      gh issue list --repo "${GH_REPO}" \
        --state open \
        --search "\"${title_prefix}${release_version}\" in:title" \
        --limit 30 \
        --json number,url,labels,author,title \
      | jq -c --arg prefix "${title_prefix}" --arg version "${release_version}" \
        '[ .[] | select(.title | startswith($prefix + $version + " on ")) | select(.author.login == "app/github-actions") ]'
    )"
    if [[ "${existing_issues}" == '[]' ]]; then
      echo "No workflow-owned release-failure issue is open for ${release_version}; nothing to reconcile."
      exit 0
    fi
    while read -r existing_issue; do
      [[ -z "${existing_issue}" ]] && continue
      issue_number="$(jq -r '.number' <<< "${existing_issue}")"
      issue_url="$(jq -r '.url' <<< "${existing_issue}")"
      body_file="$(mktemp)"
      cat > "${body_file}" <<BODY
The release completed successfully on a later attempt of this run, so the failure this issue reported is no longer current.

Release tag: ${release_version}
Run: ${DETAILS_URL} (attempt ${RUN_ATTEMPT:-unknown})

Closing as not planned. Reopen if the ${release_version} artifacts later prove incomplete.
BODY
      gh issue comment "${issue_number}" --repo "${GH_REPO}" --body-file "${body_file}" || {
        echo "::warning::Failed to comment on ${issue_url}; closing regardless."
      }
      # Removed one at a time: `gh issue edit --remove-label` fails the whole call
      # when any label is absent, and an absent label must not block the close.
      for label in 'status/ready-for-agent' 'autofix/approved' 'autofix/in-progress'; do
        gh issue edit "${issue_number}" --repo "${GH_REPO}" --remove-label "${label}" || true
      done
      gh issue close "${issue_number}" --repo "${GH_REPO}" --reason 'not planned'
    done < <(jq -c '.[]' <<< "${existing_issues}")
    ;;

  *)
    echo "unknown release step: ${step}" >&2
    exit 2
    ;;
esac
