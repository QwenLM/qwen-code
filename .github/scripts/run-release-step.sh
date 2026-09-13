#!/usr/bin/env bash
# Fail closed like the sibling runners in this directory. Without pipefail a
# connection-level `gh` failure inside a `gh ... | jq ...` substitution reads as
# an empty result (jq exits 0 on empty input), which sent notify-failure down
# its create-a-new-issue branch and past all three issue-reuse guards.
# Per-command failures stay tolerated: every `|| ...` below attaches to a whole
# command rather than to a pipeline leg, so it keeps working under pipefail.
set -eo pipefail

step="${1:?usage: run-release-step.sh <step>}"

publish_package() {
  local directory="$1"
  local published_marker="${2:-}"
  local marker_value="${3:-}"
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
    npm publish --provenance "${publish_args[@]}"
    if [[ -n "${published_marker}" ]]; then
      echo "${marker_value}" >> "${published_marker}"
    fi
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

  push-release-branch)
    release_branch_name="${BRANCH_NAME:?}"
    git add package.json package-lock.json packages/*/package.json packages/channels/*/package.json integrations/*/package.json integrations/*/qwen-extension.json
    if git diff --staged --quiet; then
      echo "No version changes to commit"
    else
      git commit -m "chore(release): ${RELEASE_TAG}"
    fi
    if [[ "${IS_DRY_RUN}" == "false" ]]; then
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
      git push --force --set-upstream origin "${release_branch_name}" --follow-tags
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
    ;;

  build-archives)
    preview_args=""
    if [[ "${OPENTUI_PREVIEW_RELEASE_ENABLED}" == "true" ]]; then
      preview_args="--include-opentui-preview"
    fi
    npm run package:standalone:release -- --version "${RELEASE_VERSION}" --out-dir dist/standalone ${preview_args}
    ;;

  publish-packages)
    if [[ "${PUBLISH_EXTERNAL_CONTEXT_MEM0}" == "true" ]]; then
      publish_package 'integrations/external-context-mem0'
    fi
    if [[ "${PUBLISH_AUDIO_CAPTURE}" == "true" ]]; then
      publish_package 'packages/audio-capture'
    fi
    publish_package 'dist'
    publish_package 'packages/channels/base'

    publish_marker="$(mktemp)"
    # Explicit allowlist: new channel packages require release approval.
    for channel in dingtalk dws feishu github qqbot telegram wecom weixin; do
      echo "::group::Publishing @qwen-code/channel-${channel}"
      publish_package "packages/channels/${channel}" "${publish_marker}" "${channel}"
      echo "::endgroup::"
    done
    if [[ "${IS_DRY_RUN}" != "true" ]] && [[ ! -s "${publish_marker}" ]]; then
      echo "::warning::Every channel package was already published; nothing shipped"
    fi
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
        '[ .[] | select(.title | startswith("Release Failed for " + $tag + " on ")) ] | (map(select(.author.login == "github-actions[bot]"))[0] // .[0]) // empty'
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
      if [[ "${issue_author}" != "github-actions[bot]" ]]; then
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

  *)
    echo "unknown release step: ${step}" >&2
    exit 2
    ;;
esac
