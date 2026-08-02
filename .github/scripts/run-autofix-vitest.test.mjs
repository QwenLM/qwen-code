import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(
  new URL('./autofix-vitest.config.mjs', import.meta.url),
  'utf8',
);
const launcher = readFileSync(
  new URL('./autofix-cli-launcher.mjs', import.meta.url),
  'utf8',
);
const wrapper = readFileSync(
  new URL('./run-autofix-vitest.sh', import.meta.url),
  'utf8',
);
const worktree = readFileSync(
  new URL('./prepare-autofix-verification-worktree.sh', import.meta.url),
  'utf8',
);

test('keeps candidate code outside the trusted Vitest worker', () => {
  assert.match(config, /pool: 'forks'/);
  assert.match(config, /singleFork: true/);
  assert.doesNotMatch(config, /execArgv|globalSetup|@qwen-code\/sdk/);
  assert.match(wrapper, /TEST_CLI_PATH="\$\{launcher\}"/);
  assert.match(
    wrapper,
    /AUTOFIX_CANDIDATE_CLI="\$\{workspace\}\/dist\/cli\.js"/,
  );
  assert.match(launcher, /process\.setgroups\(\[\]\)/);
  assert.ok(
    launcher.indexOf('process.setgroups([])') <
      launcher.indexOf('process.setgid(gid)'),
  );
  assert.ok(
    launcher.indexOf('process.setgid(gid)') <
      launcher.indexOf('process.setuid(uid)'),
  );
  assert.ok(
    launcher.indexOf('process.setuid(uid)') <
      launcher.indexOf('await import(candidateCli)'),
  );
  assert.match(launcher, /typeof candidate\.runCliEntryPoint !== 'function'/);
  assert.match(launcher, /await candidate\.runCliEntryPoint\(\)/);
  assert.ok(
    launcher.indexOf('await import(candidateCli)') <
      launcher.indexOf('await candidate.runCliEntryPoint()'),
  );
});

test('keeps the JSON proof root-owned and kills all candidate processes', () => {
  assert.match(worktree, /sudo chown root:root "\$\{home\}"/);
  assert.ok(
    worktree.indexOf('sudo chown root:root "${home}"') <
      worktree.indexOf('sudo install -d -o root -g root -m 0711'),
  );
  assert.match(worktree, /install -d -o root -g root -m 0700/);
  assert.match(wrapper, /sudo chown "root:\$\{user\}" "\$\{run_home\}"/);
  assert.match(wrapper, /sudo chmod 0770 "\$\{run_home\}"/);
  assert.match(wrapper, /sudo install -d -o root -g "\$\{user\}" -m 0770/);
  assert.match(wrapper, /setsid sudo --/);
  assert.match(wrapper, /setpriv --no-new-privs/);
  assert.match(wrapper, /--bounding-set=-dac_override,-dac_read_search/);
  assert.match(wrapper, /coordinator_pid="\$\{command_pid\}"/);
  assert.match(wrapper, /sudo kill -KILL -- "-\$\{coordinator_pid\}"/);
  assert.doesNotMatch(wrapper, /coordinator\.pid/);
  assert.match(wrapper, /AUTOFIX_VERIFY_UID="\$\{uid\}"/);
  assert.match(wrapper, /sudo pgrep -u "\$\{uid\}"/);
  assert.match(wrapper, /sudo pkill -KILL -u "\$\{uid\}"/);
  assert.match(wrapper, /sudo chown root:root "\$\{report\}"/);
  assert.match(wrapper, /sudo chmod 0444 "\$\{report\}"/);
  assert.match(
    wrapper,
    /sudo chmod 0555 "\$\{home\}\/reports\/\$\{report_name\}"/,
  );
  assert.doesNotMatch(wrapper, /GITHUB_TOKEN|CI_DEV_BOT_PAT|GITHUB_OUTPUT/);
  assert.match(wrapper, /env -i \\/);
});
