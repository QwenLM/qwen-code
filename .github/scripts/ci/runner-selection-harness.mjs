// Runs a workflow `run:` step body the way actions/runner does and reports
// what the step actually published, so a guard can check the value that
// reaches `runs-on` instead of modelling the shell that computes it.
//
// Modelling bash from file text does not work. GitHub's `${{ }}` substitution
// rewrites the script before bash parses it, so the text a static reader sees
// is not the text that runs, and the shapes that can write a value are not
// enumerable — thirteen review rounds of the lane guard each found one more.
// Executing the real body removes the question: the published value is
// observed rather than inferred.
//
// The child environment is deliberately clean — only the inputs declared
// below, plus `GITHUB_OUTPUT` bound to a real file. A body that reads anything
// else cannot be executed faithfully, and the caller fails closed on it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GitHub's fixed author_association enum. The first three carry write access,
// which is what the routing expressions branch on.
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export const ASSOCIATIONS = [
  ...TRUSTED_ASSOCIATIONS,
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  '',
];

const EVENT_NAMES = [
  'pull_request',
  'merge_group',
  'push',
  'workflow_dispatch',
  'issues',
  '',
];

// '' is the value an absent expression substitutes to, which is what a body
// sees on an event that does not carry the field at all.
const BOOLEANS = ['true', 'false', ''];

const DISPATCH_RUNNERS = ['self-hosted', ''];

// The environment keys this harness drives. A producer step whose body reads
// a name outside this list (plus GITHUB_OUTPUT and names it assigns itself)
// is one the harness cannot execute faithfully.
export const DRIVEN_ENV_KEYS = [
  'SAME_REPO',
  'AUTHOR_ASSOCIATION',
  'ECS_DISABLED',
  'EVENT_NAME',
  'DISPATCH_LINUX_RUNNER',
];

// Every combination of the driven inputs, so an executed producer is asked
// for the value it publishes on each event shape rather than on one.
export function routingEnvironments() {
  const envs = [];
  for (const SAME_REPO of BOOLEANS) {
    for (const AUTHOR_ASSOCIATION of ASSOCIATIONS) {
      for (const ECS_DISABLED of BOOLEANS) {
        for (const EVENT_NAME of EVENT_NAMES) {
          for (const DISPATCH_LINUX_RUNNER of DISPATCH_RUNNERS) {
            envs.push({
              SAME_REPO,
              AUTHOR_ASSOCIATION,
              ECS_DISABLED,
              EVENT_NAME,
              DISPATCH_LINUX_RUNNER,
            });
          }
        }
      }
    }
  }
  return envs;
}

// Executes `body` under bash with exactly `env` (plus GITHUB_OUTPUT) and
// returns the exit status, the streams, and the step outputs read back from
// the output FILE — not from stdout, which a step may echo anything to.
export function runStepBody(body, env) {
  const dir = mkdtempSync(join(tmpdir(), 'step-body-'));
  const outputFile = join(dir, 'github_output');
  try {
    const result = spawnSync('bash', ['-c', body], {
      env: { ...env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    });
    let text = '';
    try {
      text = readFileSync(outputFile, 'utf8');
    } catch {
      // A step that publishes nothing leaves no file behind.
    }
    const outputs = new Map();
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        outputs.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      outputs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
