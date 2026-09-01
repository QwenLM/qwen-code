/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/build-and-publish-image.yml',
  'utf8',
);
const processVersionStep =
  workflow.match(
    /- name: 'Process version'[\s\S]*?(?=\n[ ]{6}- name: 'Debug inputs')/,
  )?.[0] ?? '';
const metadataStep =
  workflow.match(
    /- name: 'Extract metadata \(tags, labels\) for Docker'[\s\S]*?(?=\n[ ]{6}- name: 'Log in to the Container registry')/,
  )?.[0] ?? '';
const buildStep =
  workflow.match(
    /- name: 'Build and push Docker image'\n[\s\S]*?(?=\n[ ]{6}# One bounded retry)/,
  )?.[0] ?? '';
const retryStep =
  workflow.match(
    /- name: 'Build and push Docker image \(retry\)'[\s\S]*?(?=\n[ ]{2}# One issue per version)/,
  )?.[0] ?? '';
const failureIssueJob =
  workflow.match(/file-failure-issue:[\s\S]*$/)?.[0] ?? '';
const buildJob =
  workflow.match(
    /build-and-push-to-ghcr:[\s\S]*?(?=\n[ ]{2}# One issue per version)/,
  )?.[0] ?? '';
const failureIssueScript = readFileSync(
  '.github/scripts/image-build-failure-issue.sh',
  'utf8',
);

describe('build-and-publish-image workflow', () => {
  it('marks only stable three-part semver versions as stable', () => {
    expect(processVersionStep).toContain(
      'if [[ "$CLEAN_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    );
    expect(processVersionStep).toContain('IS_STABLE_SEMVER=true');
    expect(processVersionStep).toContain('IS_STABLE_SEMVER=false');
    expect(processVersionStep.indexOf('IS_STABLE_SEMVER=true')).toBeLessThan(
      processVersionStep.indexOf('IS_STABLE_SEMVER=false'),
    );
  });

  it('only enables floating Docker tags for stable semver versions', () => {
    expect(metadataStep).toContain(
      "type=raw,value=${{ steps.version.outputs.major_minor }},enable=${{ steps.version.outputs.is_stable_semver == 'true' }}",
    );
    expect(metadataStep).toContain(
      "type=raw,value=latest,enable=${{ steps.version.outputs.is_stable_semver == 'true' }}",
    );
  });

  it('keeps a failed first build from pre-failing the job', () => {
    // Without continue-on-error a successful retry would leave the job red
    // (GitHub computes the job conclusion from every step conclusion), which
    // would make file-failure-issue report an image that WAS published.
    expect(buildStep).toContain('continue-on-error: true');
  });

  it('gates the retry on the first attempt outcome only', () => {
    expect(retryStep).toContain(
      'if: "${{ steps.build-and-push.outcome == \'failure\' }}"',
    );
    // failure() would be false once continue-on-error absorbs the first
    // attempt, silently skipping the retry.
    expect(retryStep).not.toContain('failure()');
  });

  it('pins the first build step id the retry gate references', () => {
    // steps.build-and-push.outcome only resolves when this exact id exists;
    // renaming the step would silently disable the retry.
    expect(buildStep).toContain("id: 'build-and-push'");
  });

  it('lets a failed retry fail the job', () => {
    // continue-on-error on the retry would absorb a genuine build failure and
    // leave the job green, so file-failure-issue would never run.
    expect(retryStep).not.toContain('continue-on-error');
  });

  it('publishes from both build steps through one shared expression', () => {
    expect(buildStep).toContain("push: '${{ env.PUSH_IMAGE }}'");
    expect(retryStep).toContain("push: '${{ env.PUSH_IMAGE }}'");
    expect(workflow).toContain('PUSH_IMAGE: |-');
  });

  it('pins the PUSH_IMAGE value and the login gate at the definition site', () => {
    // Pinning only the key's existence lets `${{ false }}` pass: login is
    // skipped, both builds run with push: false, the job concludes green,
    // and file-failure-issue never fires — a released version would ship
    // with no GHCR image, silently reproducing incident #9898.
    expect(workflow).toContain(
      "PUSH_IMAGE: |-\n        ${{ (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && github.event.inputs.publish == 'true') }}",
    );
    expect(workflow).toContain(
      "- name: 'Log in to the Container registry'\n        if: \"${{ env.PUSH_IMAGE == 'true' }}\"",
    );
  });

  it('gates the failure-issue job on the exported publish decision', () => {
    // The publish predicate lives only in PUSH_IMAGE. Job-level `if:` cannot
    // read the env context, so the decision reaches the reporting job through
    // a build-job output; restating the predicate in the gate would let the
    // two drift apart (a widened PUSH_IMAGE whose failed run files no issue,
    // or a narrowed one filing bogus issues).
    expect(failureIssueJob).toContain(
      "needs.build-and-push-to-ghcr.outputs.push_image == 'true'",
    );
    expect(failureIssueJob).not.toContain('startsWith(github.ref,');
    expect(failureIssueJob).not.toContain('github.event.inputs.publish');
  });

  it('skips the failure-issue job for publishing dispatches without a version', () => {
    // The dispatch arm of the gate admits an empty version input (required:
    // false), which the build job services with its branch/sha fallback
    // tags. The reporting job files one issue per VERSION and hard-fails on
    // a versionless run, so the gate skips that combination by design. Tag
    // pushes always carry a version through the tag name.
    expect(failureIssueJob).toContain(
      "(github.event_name == 'push' || github.event.inputs.version != '')",
    );
  });

  it('exports the publish decision before any step that can fail', () => {
    expect(buildJob).toContain(
      "push_image: '${{ steps.publish-decision.outputs.push_image }}'",
    );
    expect(buildJob).toContain("id: 'publish-decision'");
    // The gate output must exist even when checkout or a build step fails,
    // so the exporting step runs first and reads the job-level PUSH_IMAGE.
    expect(buildJob).toContain(
      'echo "push_image=${PUSH_IMAGE}" >> "$GITHUB_OUTPUT"',
    );
    expect(buildJob.indexOf("'Export the publish decision'")).toBeLessThan(
      buildJob.indexOf("'Checkout repository'"),
    );
  });

  it('only runs the failure-issue job after a failed in-repo build', () => {
    // failure() keeps green builds from filing, the repository guard keeps
    // forks from filing, and needs wires the job to the build it reports on.
    // Deleting any of these must fail the suite.
    expect(failureIssueJob).toContain(
      "failure() && github.repository == 'QwenLM/qwen-code'",
    );
    expect(failureIssueJob).toContain("needs: ['build-and-push-to-ghcr']");
  });

  it('dedups the failure issue by an exact client-side marker match', () => {
    // GitHub search tokenizes the colon out of the marker, so a --search
    // lookup never finds the issues this job files. The lookup itself is
    // shared with the ECS fleet reporter, which files marker-bearing issues
    // into the same `scope/ci-cd` label space: a guard applied to one copy
    // and missed in the other makes the other file duplicates.
    expect(failureIssueJob).toContain(
      'bash .github/scripts/image-build-failure-issue.sh',
    );
    expect(failureIssueScript).toContain(
      'bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"',
    );
    expect(failureIssueScript).toContain('MARKER_HTML="${marker_html}"');
    const lookupScript = readFileSync(
      '.github/scripts/find-marked-issue.sh',
      'utf8',
    );
    expect(lookupScript).not.toContain('--search');
    expect(lookupScript).toContain('jq -r --arg marker_html "${MARKER_HTML}"');
    expect(lookupScript).toContain('contains($marker_html)');
  });
});

// Replay the script under a recording gh stub instead of pinning only the
// mechanism's text: text pins stayed green when `.body` was mutated to
// `.title` (lookup matches nothing, the script dies, nothing is filed) and
// when the marker lost its `:${version}` suffix (every later version
// rewrites the first issue). jq is preinstalled on ubuntu-latest runners.
// The replay also needs POSIX paths and an extensionless gh stub, which the
// Windows lane cannot express (backslash RUNNER_TEMP, ';'-separated PATH);
// it skips there while the YAML suite above still runs.
const replayable =
  process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!replayable)(
  'image-build-failure-issue script behavior',
  () => {
    const runScript = ({
      eventName,
      tagName = '',
      inputVersion = '',
      issues,
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'image-failure-issue-'));
      const callsLog = join(dir, 'calls.log');
      const bodyCapture = join(dir, 'captured-body.md');
      // Not open-issues.json: the script redirects `gh issue list` into
      // ${RUNNER_TEMP}/open-issues.json, which would truncate this fixture.
      const fixture = join(dir, 'fixture-issues.json');
      writeFileSync(fixture, JSON.stringify(issues));
      // The recurrence path fetches the tracked issue's body through
      // `gh issue view <number>`; serve it from a per-issue fixture file.
      for (const issue of issues) {
        writeFileSync(
          join(dir, `issue-${issue.number}.body`),
          issue.body ?? '',
        );
      }
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/bin/bash',
          'echo "gh $*" >> "' + callsLog + '"',
          'prev=""',
          'for arg in "$@"; do',
          '  if [[ "$prev" == "--body-file" ]]; then cp "$arg" "' +
            bodyCapture +
            '"; fi',
          '  prev="$arg"',
          'done',
          'case "$1 $2" in',
          '  "issue list") cat "' + fixture + '" ;;',
          '  "issue view") cat "' + dir + '/issue-$3.body" ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'gh'), 0o755);
      const result = spawnSync(
        'bash',
        ['.github/scripts/image-build-failure-issue.sh'],
        {
          encoding: 'utf8',
          env: {
            PATH: dir + ':' + (process.env.PATH ?? ''),
            REPO: 'QwenLM/qwen-code',
            EVENT_NAME: eventName,
            TAG_NAME: tagName,
            INPUT_VERSION: inputVersion,
            DEDUP_LABEL: 'scope/ci-cd',
            RUN_URL:
              'https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
            RUNNER_TEMP: dir,
          },
        },
      );
      return {
        status: result.status,
        out: result.stdout,
        calls: existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '',
        body: existsSync(bodyCapture) ? readFileSync(bodyCapture, 'utf8') : '',
      };
    };

    it('records the recurrence on the existing issue instead of creating', () => {
      const previousRun =
        'https://github.com/QwenLM/qwen-code/actions/runs/32580000000';
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            title:
              'Sandbox image for 1.2.3 not published: release build job failed',
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              'The release build job for `1.2.3` failed before the image could be published.\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              `- ${previousRun}\n`,
          },
          { number: 43, title: 'unrelated', body: 'no marker here' },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.calls).not.toContain('issue create');
      // The dedup lookup must stay open-only: with `--state all` a closed
      // marker issue (image recovered) matches the next failure and the
      // script edits the CLOSED issue instead of opening a fresh alert —
      // the silent-failure mode this PR exists to prevent. Only the list
      // call carries this substring.
      expect(result.calls).toContain('--state open');
      // The lookup side of the dedup contract: the list call filters on the
      // same label the create call applies. Without the filter the lookup
      // scans the newest 200 of ALL open issues; an older marker issue can
      // fall out of that window and the script files a duplicate.
      expect(result.calls).toContain(
        'issue list --repo QwenLM/qwen-code --state open --label scope/ci-cd',
      );
      expect(result.body).toContain('<!-- image-build-failure:1.2.3 -->');
      // The new run is appended to the recorded list, newest first, instead
      // of replacing it — the previous run URL must survive.
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
      expect(result.body).toContain(`- ${previousRun}`);
      expect(result.body.indexOf('32580293377')).toBeLessThan(
        result.body.indexOf('32580000000'),
      );
    });

    it('keeps hand-written annotations on recurrence instead of wiping them', () => {
      const annotation =
        'Do not republish — the npm package is broken, tracked in #9999.';
      const previousRun =
        'https://github.com/QwenLM/qwen-code/actions/runs/32580000000';
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            title:
              'Sandbox image for 1.2.3 not published: release build job failed',
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              'The release build job for `1.2.3` failed before the image could be published.\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              `- ${previousRun}\n` +
              '\n' +
              `${annotation}\n`,
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body).toContain(annotation);
      expect(result.body).toContain(`- ${previousRun}`);
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('keeps hand-written notes when the existing body predates the run block', () => {
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            title:
              'Sandbox image for 1.2.3 not published: release build job failed',
            body: '<!-- image-build-failure:1.2.3 -->\n\nHand-written note.',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.calls).not.toContain('issue create');
      expect(result.body).toContain('Hand-written note.');
      expect(result.body).toContain('<!-- image-build-failure:1.2.3 -->');
      expect(result.body).toContain(
        'https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('does not record the same run twice on a repeated failure', () => {
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            title:
              'Sandbox image for 1.2.3 not published: release build job failed',
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body.match(/actions\/runs\/32580293377/g)).toHaveLength(1);
    });

    it('caps the recorded runs at the newest ten', () => {
      // Ten existing runs (newest first, as the script maintains the block)
      // plus this one must drop the oldest and keep exactly ten.
      const runs = Array.from(
        { length: 10 },
        (_, i) =>
          `- https://github.com/QwenLM/qwen-code/actions/runs/3258000000${
            9 - i
          }`,
      );
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              runs.join('\n') +
              '\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      const bullets =
        result.body.match(
          /^- https:\/\/github\.com\/QwenLM\/qwen-code\/actions\/runs\/\d+$/gm,
        ) ?? [];
      expect(bullets).toHaveLength(10);
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
      expect(result.body).not.toContain('32580000000');
      expect(result.body.indexOf('32580293377')).toBeLessThan(
        result.body.indexOf('32580000009'),
      );
    });

    it('emits the run-block heading exactly once after a stranded one', () => {
      // A human edit deleted the occurrences marker line and every bullet,
      // leaving the head ending on a stranded '## Failed runs' that the
      // rebuilt block must absorb, not duplicate.
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              'The release build job for `1.2.3` failed before the image could be published.\n' +
              '\n' +
              '## Failed runs\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body.match(/## Failed runs/g)).toHaveLength(1);
      expect(result.body).toContain('<!-- image-build-failure-occurrences -->');
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('keeps the dedup marker when it survives only outside the head prose', () => {
      // The marker can sit on a line the split re-emits with the tail; the
      // rebuilt body must still carry it or the next failure files a
      // duplicate and orphans the tracked issue.
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              'The release build job for `1.2.3` failed before the image could be published.\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              '- https://github.com/QwenLM/qwen-code/actions/runs/32580000000 <!-- image-build-failure:1.2.3 -->\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.calls).not.toContain('issue create');
      expect(result.body).toContain('<!-- image-build-failure:1.2.3 -->');
      expect(result.body).toContain('The release build job for `1.2.3` failed');
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('restores the narrative when the body starts at the occurrences marker', () => {
      // Nothing above the marker: the empty head falls back to the generated
      // prose, so the narrative is never lost. The pre-existing marker below
      // the block is re-emitted with the tail, so two copies are expected.
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              '<!-- image-build-failure-occurrences -->\n' +
              '- https://github.com/QwenLM/qwen-code/actions/runs/32580000000\n' +
              '<!-- image-build-failure:1.2.3 -->\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body).toContain('The release build job for `1.2.3` failed');
      expect(result.body).toContain('<!-- image-build-failure:1.2.3 -->');
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580000000',
      );
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('restores the narrative when the head normalizes down to nothing', () => {
      // Only a stranded heading above the marker: the normalization strip
      // empties the head AFTER the initial readability check, so the prose
      // fallback must run again after the strip.
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              '- https://github.com/QwenLM/qwen-code/actions/runs/32580000000\n' +
              '\n' +
              '<!-- image-build-failure:1.2.3 -->\n',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body).toContain('The release build job for `1.2.3` failed');
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580000000',
      );
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('keeps a bullet-shaped annotation out of the recorded runs', () => {
      const annotation =
        '- do not republish — the npm package is broken, tracked in #9999.';
      const firstRun =
        'https://github.com/QwenLM/qwen-code/actions/runs/32580000000';
      const secondRun =
        'https://github.com/QwenLM/qwen-code/actions/runs/32580000001';
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '1.2.3',
        issues: [
          {
            number: 42,
            body:
              '<!-- image-build-failure:1.2.3 -->\n' +
              '\n' +
              '## Failed runs\n' +
              '\n' +
              '<!-- image-build-failure-occurrences -->\n' +
              `- ${firstRun}\n` +
              `${annotation}\n` +
              `- ${secondRun}\n`,
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.body).toContain(annotation);
      expect(result.body).toContain(`- ${secondRun}`);
      // The annotation is human prose, not a recorded run: it must not be
      // reordered into the machine block or counted against the run cap.
      const block = result.body.split(
        '<!-- image-build-failure-occurrences -->',
      )[1];
      expect(block).toContain(`- ${firstRun}`);
      expect(block).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
      expect(block).not.toContain('do not republish');
    });

    it('creates a new issue when no open issue carries the version marker', () => {
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '4.5.6',
        issues: [
          {
            number: 42,
            title:
              'Sandbox image for 1.2.3 not published: release build job failed',
            body: '<!-- image-build-failure:1.2.3 -->',
          },
        ],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue create');
      expect(result.calls).not.toContain('issue edit');
      // The dedup lookup filters on DEDUP_LABEL, so the create call must
      // apply it or every later lookup finds nothing and files duplicates.
      // Scoped to the create line: the list call carries the label too.
      const createCall = result.calls
        .split('\n')
        .find((call) => call.startsWith('gh issue create'));
      expect(createCall).toContain('--label scope/ci-cd');
      expect(result.calls).toContain(
        'Sandbox image for 4.5.6 not published: release build job failed',
      );
      expect(result.body).toContain('<!-- image-build-failure:4.5.6 -->');
      expect(result.body).toContain('## Failed runs');
      expect(result.body).toContain('<!-- image-build-failure-occurrences -->');
      expect(result.body).toContain(
        '- https://github.com/QwenLM/qwen-code/actions/runs/32580293377',
      );
    });

    it('matches a v-prefixed tag push against the versioned marker', () => {
      // Tag pushes name the version through the tag; dispatches through the
      // input. Both must normalize to the same marker or the second event
      // files a duplicate issue that can never be deduped.
      const result = runScript({
        eventName: 'push',
        tagName: 'v1.2.3',
        issues: [{ number: 42, body: '<!-- image-build-failure:1.2.3 -->' }],
      });
      expect(result.status).toBe(0);
      expect(result.calls).toContain('gh issue edit 42');
      expect(result.calls).not.toContain('issue create');
    });

    it('hard-fails instead of filing when no version resolves', () => {
      const result = runScript({
        eventName: 'workflow_dispatch',
        inputVersion: '',
        issues: [],
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain('::error::');
      expect(result.calls).not.toContain('issue create');
      expect(result.calls).not.toContain('issue edit');
    });
  },
);
