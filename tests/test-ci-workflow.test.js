/* 
  CI Workflow Tests

  Note on framework: These tests are written using the repository's existing JavaScript testing framework.
  - If Jest is configured, they run under Jest (describe/it/expect).
  - If Mocha/Chai is used, they are compatible with Mocha's describe/it and Node's assert.
  - If Vitest is used, they are compatible with describe/it/expect as well.

  They validate the GitHub Actions workflow named "Test CI Workflow" introduced/modified by the PR diff.
*/

const fs = require('fs');
const path = require('path');

let expectFn = undefined;
let assert;
try {
  // Prefer Jest/Vitest style expect if available
  expectFn = global.expect;
} catch {}
try {
  // Fallback to Node assert if expect is not defined
  assert = require('assert');
} catch {}

/**
 * Try to load a YAML parser present in the repo without adding new deps.
 * Priority: js-yaml -> yaml
 */
let yaml;
let yamlLibName = null;
try {
  yaml = require('js-yaml');
  yamlLibName = 'js-yaml';
} catch (e1) {
  try {
    yaml = require('yaml');
    yamlLibName = 'yaml';
  } catch (e2) {
    yaml = null;
  }
}

function expectLike(actual) {
  if (expectFn) return expectFn(actual);
  // Minimal expect-like helpers using assert for Mocha without Chai
  return {
    toBe: (v) => assert.strictEqual(actual, v),
    toEqual: (v) => assert.deepStrictEqual(actual, v),
    toContain: (v) => {
      if (typeof actual === 'string') assert.ok(actual.includes(v), `Expected string to contain "${v}", got: ${actual}`);
      else if (Array.isArray(actual)) assert.ok(actual.includes(v), `Expected array to contain "${v}", got: ${JSON.stringify(actual)}`);
      else throw new Error('toContain supports strings and arrays only');
    },
    toMatch: (re) => {
      assert.ok(re.test(actual), `Expected value to match ${re}, got: ${actual}`);
    },
    toBeDefined: () => {
      assert.notStrictEqual(typeof actual, 'undefined');
    },
    toBeTruthy: () => {
      assert.ok(!!actual);
    }
  };
}

function getWorkflowPath() {
  // Path is injected from the shell script via env var if provided
  const envPath = process.env.CI_WORKFLOW_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Common locations fallback
  const candidates = [
    '.github/workflows/test-ci-workflow.yml',
    '.github/workflows/test-ci-workflow.yaml'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // As a last resort, scan workflows dir for the name
  const workflowsDir = '.github/workflows';
  if (fs.existsSync(workflowsDir)) {
    const files = fs.readdirSync(workflowsDir);
    for (const f of files) {
      const full = path.join(workflowsDir, f);
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (/^name:\s*['"]?Test CI Workflow['"]?/m.test(text)) {
          return full;
        }
      } catch {}
    }
  }
  throw new Error('Could not locate the "Test CI Workflow" file.');
}

function loadWorkflowDoc(raw) {
  if (!yaml) {
    // No YAML parser available; provide a helpful failure that points to missing parser.
    const msg = [
      'No YAML parser (js-yaml or yaml) found. Please ensure one is present in devDependencies.',
      'This test suite prefers using existing dependencies and will not install new ones.',
      'Raw content checks will still run.'
    ].join('\n');
    // eslint-disable-next-line no-console
    console.warn(msg);
    return null;
  }
  try {
    if (yamlLibName === 'js-yaml') {
      return yaml.load(raw);
    }
    // yaml (eemeli) library
    if (yamlLibName === 'yaml') {
      return yaml.parse(raw);
    }
  } catch (err) {
    throw new Error('Failed to parse workflow YAML: ' + err.message);
  }
  return null;
}

describe('GitHub Actions - Test CI Workflow', () => {
  const workflowPath = getWorkflowPath();
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const doc = loadWorkflowDoc(raw);

  it('should exist at a discoverable path', () => {
    expectLike(fs.existsSync(workflowPath)).toBeTruthy();
  });

  it('should be named "Test CI Workflow"', () => {
    if (doc) {
      expectLike(doc.name).toBe('Test CI Workflow');
    } else {
      expectLike(/^name:\s*['"]?Test CI Workflow['"]?/m.test(raw)).toBeTruthy();
    }
  });

  it('should trigger on push and pull_request to ci-test-branch and allow workflow_dispatch', () => {
    if (doc) {
      // on.push.branches includes ci-test-branch
      const pushBranches = doc.on && doc.on.push && doc.on.push.branches;
      expectLike(Array.isArray(pushBranches)).toBeTruthy();
      expectLike(pushBranches).toContain('ci-test-branch');

      // on.pull_request.branches includes ci-test-branch
      const prBranches = doc.on && doc.on.pull_request && doc.on.pull_request.branches;
      expectLike(Array.isArray(prBranches)).toBeTruthy();
      expectLike(prBranches).toContain('ci-test-branch');

      // workflow_dispatch exists (can be {} or null or true-like)
      expectLike(Object.prototype.hasOwnProperty.call(doc.on || {}, 'workflow_dispatch')).toBeTruthy();
    } else {
      // Raw checks
      expectLike(/on:\s*\n(?:[\s\S]*?)push:\s*\n(?:[\s\S]*?)branches:\s*\n(?:[\s\S]*?)-\s*['"]?ci-test-branch['"]?/m.test(raw)).toBeTruthy();
      expectLike(/pull_request:\s*\n(?:[\s\S]*?)branches:\s*\n(?:[\s\S]*?)-\s*['"]?ci-test-branch['"]?/m.test(raw)).toBeTruthy();
      expectLike(/workflow_dispatch:/m.test(raw)).toBeTruthy();
    }
  });

  it('should define a "test" job running on ubuntu-latest', () => {
    if (doc) {
      expectLike(doc.jobs).toBeDefined();
      expectLike(typeof doc.jobs.test).toBeTruthy();
      expectLike(doc.jobs.test['runs-on']).toBe('ubuntu-latest');
    } else {
      expectLike(/jobs:\s*\n\s*test:\s*\n(?:[\s\S]*?)runs-on:\s*['"]?ubuntu-latest['"]?/m.test(raw)).toBeTruthy();
    }
  });

  it('should include a pinned actions/checkout step with the expected commit SHA', () => {
    const pinnedSha = '08c6903cd8c0fde910a37f88322edcfb5dd907a8';
    const pinnedPattern = new RegExp(`actions/checkout@${pinnedSha.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`);
    expectLike(pinnedPattern.test(raw)).toBeTruthy();

    // Also ensure it's pinned (40-hex SHA), not a floating tag like v4
    const unpinnedPattern = /\bactions\/checkout@v?\d+(?:\.\d+)*\b/;
    // Strip YAML comments before checking for unpinned refs
    const codeOnly = raw
      .split('\n')
      .map((l) => l.split('#')[0])
      .join('\n');
    expectLike(unpinnedPattern.test(codeOnly)).toBe(false);
  });

  it('should include the ratchet comment documenting the pinned source', () => {
    // Comments are not available via YAML parser; check raw text.
    expectLike(/#\s*ratchet:actions\/checkout@v4/.test(raw)).toBeTruthy();
  });

  it('should include a "Run a simple test" step that echoes key info', () => {
    if (doc && doc.jobs && doc.jobs.test && Array.isArray(doc.jobs.test.steps)) {
      const steps = doc.jobs.test.steps;
      const runStep = steps.find(s => s.name === 'Run a simple test');
      expectLike(!!runStep).toBeTruthy();
      const content = (runStep && runStep.run) || '';
      expectLike(typeof content === 'string').toBeTruthy();
      expectLike(content).toContain("CI is working!");
      expectLike(content).toContain("${{ github.ref }}");
      expectLike(content).toContain("${{ github.repository }}");
    } else {
      // Raw content fallback assertions
      expectLike(/- name:\s*['"]?Run a simple test['"]?\s*\n\s*run:\s*\|/m.test(raw)).toBeTruthy();
      expectLike(/echo\s+['"]CI is working!['"]/.test(raw)).toBeTruthy();
      expectLike(/echo\s+"Branch:\s*\${{\s*github\.ref\s*}}"/.test(raw)).toBeTruthy();
      expectLike(/echo\s+"Repository:\s*\${{\s*github\.repository\s*}}"/.test(raw)).toBeTruthy();
    }
  });

  it('should have at least two steps (checkout and run test)', () => {
    if (doc && doc.jobs && doc.jobs.test) {
      const steps = doc.jobs.test.steps || [];
      expectLike(Array.isArray(steps)).toBeTruthy();
      expectLike(steps.length >= 2).toBeTruthy();
    } else {
      // Approximate by raw matches
      const stepsCount = (raw.match(/^\s*-\s+name:/gm) || []).length + (raw.match(/^\s*-\s+uses:/gm) || []).length;
      expectLike(stepsCount >= 2).toBeTruthy();
    }
  });
});