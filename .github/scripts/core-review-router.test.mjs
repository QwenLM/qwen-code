import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './core-review-router.mjs';

describe('classify', () => {
  it('returns no reviewers when no core files changed', () => {
    const result = classify(
      ['packages/cli/src/foo.ts', 'packages/web-shell/client/App.tsx'],
      'someone',
    );
    assert.equal(result.reviewers.length, 0);
    assert.match(result.reason, /no core files/);
  });

  it('returns no reviewers for core test-only changes', () => {
    const result = classify(
      [
        'packages/core/src/tools/grep.test.ts',
        'packages/core/src/utils/truncation.test.ts',
      ],
      'someone',
    );
    assert.equal(result.reviewers.length, 0);
    assert.match(result.reason, /test-only/);
  });

  it('assigns 1 reviewer for incidental core touch in a large non-core PR', () => {
    const files = [
      'packages/web-shell/client/App.tsx',
      'packages/web-shell/client/components/Foo.tsx',
      'packages/web-shell/client/components/Bar.tsx',
      'packages/web-shell/client/hooks/useBaz.ts',
      'packages/cli/src/ui/AppContainer.tsx',
      'packages/core/src/services/session-transcript-reader.ts',
      'packages/core/src/services/session-transcript-reader.test.ts',
    ];
    const result = classify(files, 'ytahdn');
    assert.equal(result.reviewers.length, 1);
    assert.match(result.reason, /incidental/);
  });

  it('assigns 1 reviewer for a small 2-file core fix', () => {
    const result = classify(
      [
        'packages/core/src/tools/agent/agent.ts',
        'packages/core/src/tools/agent/agent.test.ts',
      ],
      'Truraly',
    );
    assert.equal(result.reviewers.length, 1);
    assert.ok(result.reviewers.includes('tanzhenxin'));
    assert.match(result.reason, /small core change/);
  });

  it('assigns 2 reviewers for a significant core change', () => {
    const files = [
      'packages/core/src/core/client.ts',
      'packages/core/src/core/turn.ts',
      'packages/core/src/tools/grep.ts',
      'packages/core/src/tools/read-file.ts',
      'packages/core/src/utils/truncation.ts',
    ];
    const result = classify(files, 'someone');
    assert.equal(result.reviewers.length, 2);
    assert.match(result.reason, /significant/);
  });

  it('picks the domain expert based on changed paths', () => {
    const result = classify(
      [
        'packages/core/src/permissions/permission-manager.ts',
        'packages/core/src/confirmation-bus/bus.ts',
      ],
      'someone',
    );
    assert.ok(result.reviewers.includes('LaZzyMan'));
  });

  it('picks yiliang114 for models/providers changes', () => {
    const result = classify(
      ['packages/core/src/models/modelsConfig.ts'],
      'someone',
    );
    assert.ok(result.reviewers.includes('yiliang114'));
  });

  it('picks wenshao for skills/subagents/agents changes', () => {
    const result = classify(
      ['packages/core/src/subagents/subagent-manager.ts'],
      'someone',
    );
    assert.ok(result.reviewers.includes('wenshao'));
  });

  it('excludes the PR author from reviewers', () => {
    const result = classify(
      ['packages/core/src/models/modelsConfig.ts'],
      'yiliang114',
    );
    assert.ok(!result.reviewers.includes('yiliang114'));
  });

  it('handles __tests__ directory as test files', () => {
    const result = classify(
      ['packages/core/src/providers/__tests__/install.test.ts'],
      'someone',
    );
    assert.equal(result.reviewers.length, 0);
  });

  it('assigns 1 reviewer when core ratio is low even with 1 prod file', () => {
    const files = Array.from(
      { length: 10 },
      (_, i) => `packages/cli/src/file${i}.ts`,
    );
    files.push('packages/core/src/index.ts');
    const result = classify(files, 'someone');
    assert.equal(result.reviewers.length, 1);
    assert.match(result.reason, /incidental/);
  });

  it('assigns 1 reviewer for 1 core prod file when PR is core-focused', () => {
    const result = classify(
      [
        'packages/core/src/services/sessionService.ts',
        'packages/core/src/services/sessionService.test.ts',
      ],
      'zjunothing',
    );
    assert.equal(result.reviewers.length, 1);
    assert.match(result.reason, /small core change/);
  });

  it('rotates the second reviewer across PRs via prNumber', () => {
    const files = [
      'packages/core/src/core/client.ts',
      'packages/core/src/core/turn.ts',
      'packages/core/src/tools/grep.ts',
    ];
    const seconds = new Set();
    for (let pr = 0; pr < 6; pr++) {
      const { reviewers } = classify(files, 'someone', pr);
      assert.equal(reviewers.length, 2);
      seconds.add(reviewers[1]);
    }
    assert.ok(seconds.size >= 2, `expected rotation, got: ${[...seconds]}`);
  });

  it('uses round-robin fallback for unmapped core dirs (not fixed wenshao)', () => {
    const files = ['packages/core/src/telemetry/loggers.ts'];
    const first = new Set();
    for (let pr = 0; pr < 8; pr++) {
      const { reviewers } = classify(files, 'someone', pr);
      assert.equal(reviewers.length, 1);
      first.add(reviewers[0]);
    }
    assert.ok(
      first.size >= 2,
      `unmapped dir should rotate, got: ${[...first]}`,
    );
  });

  it('fills reviewers from rotated pool when domain expert is the author', () => {
    const result = classify(
      ['packages/core/src/tools/grep.ts'],
      'tanzhenxin',
    );
    assert.equal(result.reviewers.length, 1);
    assert.ok(!result.reviewers.includes('tanzhenxin'));
  });

  it('returns domain expert first and a distinct second for count=2', () => {
    const files = [
      'packages/core/src/permissions/permission-manager.ts',
      'packages/core/src/permissions/permission-flow.ts',
      'packages/core/src/core/client.ts',
    ];
    const result = classify(files, 'someone', 0);
    assert.equal(result.reviewers.length, 2);
    assert.equal(result.reviewers[0], 'LaZzyMan');
    assert.notEqual(result.reviewers[0], result.reviewers[1]);
  });

  it('singularizes "prod file" for 1-file changes', () => {
    const result = classify(
      [
        'packages/core/src/tools/grep.ts',
        'packages/core/src/tools/grep.test.ts',
      ],
      'someone',
    );
    assert.match(result.reason, /1 prod file\b/);
    assert.doesNotMatch(result.reason, /1 prod files/);
  });

  it('ignores package.json version bumps (release PRs)', () => {
    const result = classify(
      [
        'CHANGELOG.md',
        'package.json',
        'packages/core/package.json',
        'packages/cli/package.json',
      ],
      'qwen-code-ci-bot',
      7461,
    );
    assert.equal(result.reviewers.length, 0);
    assert.match(result.reason, /no core files/);
  });

  it('ignores tsconfig files as non-source', () => {
    const result = classify(
      [
        'packages/core/tsconfig.json',
        'packages/core/tsconfig.build.json',
      ],
      'someone',
    );
    assert.equal(result.reviewers.length, 0);
    assert.match(result.reason, /no core files/);
  });
});
