/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionMode,
  type PermissionRules,
} from '../../permissions/manager/decision/index.js';
import { initializeShellParsers } from '../../utils/shell-utils.js';
import { checkShellPermission } from './shellPermissions.js';
import { withSessionModeForTest } from '../../test-utils/config.js';
import { withToolLevelRules } from '../tool-checkers/rule-precedence.js';
import { createShellToolChecker } from '../tool-checkers/checkers/bash-checker.js';
import { isDangerousShellCommand } from './dangerousCommandDetection.js';

const benchmarkCleanup = String.raw`cd /tmp && rm -rf __pycache__ bench1.py bench2.py bench3.py bench4.py bench2.log bench3.log bench4.log \
  dbg1.py dbg2.py dbg3.py dbg4.py dbg5.py dbg6.py dbg7.py \
  diff_c.log diff_new.log e.cnf e.out exp1.py exp1.log \
  fm_a.py fm_c.py fm_g.py fm_i.py fm_j.py fm_k.py fm_l.py fm_n.py fm_nowit.py fm_p.py fm_r.py fm_s.py fm_t.py fm_w.py \
  fuzz_bitset.log fuzz_solver.log fuzz_sparse.py fuzz_units.py \
  gen3.py h10.json hang20.json hard.log inst3.py inst4.py inst5.py inst6.py \
  instr.py instr.log instr2.py instr2.log prof1.py prof1.log prof2.py prof2.log \
  r3_50_*.cnf r3_80_*.cnf r3_100_*.cnf r3_150_*.cnf r3_200_*.cnf \
  scan3.py scan3.log scale.log scale_c.log t.cnf t.out td.log \
  t3.py t3.log t4.py t4.log t5.py t6.py t7.py t8.py t8.log t9.py \
  t10.py t11.py t12.py t13.py t14.py t15.py t15.log t16.py t17.py t18.py t19.py \
  t20.py t20.log t21.py t21.log t22.py t22.log t23.py t24.py t24.log t25.py t25.log \
  t26.py t26.log t27.py t27.log t28.py t28.log t29.py t29.log t30.py t30.log t31.py t31.log t32.py
echo "remaining non-harness files in /tmp:"
ls /tmp | grep -v -E '^(perf-litellm|qoder|sandbox_monitor|qodercli-natives|tmp\.)' | tr '\n' ' '; echo
echo "harness files intact: $(ls /tmp | grep -cE '^(perf-litellm|qoder|sandbox_monitor|qodercli-natives|tmp\.)')"`;

const brokerCleanup = String.raw`rm -f /tmp/validate_all.sh /tmp/sub_plain.out /tmp/sub_plain.err /tmp/pub_plain.err \
      /tmp/sub_tls.out /tmp/sub_tls.err /tmp/pub_tls.err /tmp/f1.out /tmp/f2.out \
      /tmp/v1 /tmp/v2 /tmp/t1.conf /tmp/t2.conf /tmp/plain_vars.sh /tmp/tls_vars.sh \
      /tmp/retained_before.txt /tmp/retained_after.txt /tmp/retained_msg.txt /tmp/retained_topic.txt
echo "=== FINAL STATE ==="
PID=$(cat /run/mosquitto/mosquitto.pid)
echo "broker PID: $PID"
ps -o pid,user,etime,args -p "$PID" --no-headers
echo "enabled: $(systemctl is-enabled mosquitto.service 2>&1)"
ss -ltn | grep -E ':1883|:8883'
echo "--- persistence db ---"; ls -l /var/lib/mosquitto/mosquitto.db
echo "--- log errors from broker itself ---"; grep -icE "error|warning" /var/log/mosquitto/mosquitto.log
echo "--- /app files: $(ls -1 /app/*.txt | wc -l) ---"`;

beforeAll(initializeShellParsers);
const rules: PermissionRules = { allow: {}, deny: {}, ask: {} };
const checker = withSessionModeForTest(
  withToolLevelRules('Bash', createShellToolChecker('Bash')),
  'Bash',
);
function checkMode(
  command: string,
  mode: PermissionMode,
  selectedRules = rules,
) {
  return checker.check(
    { command },
    {
      mode,
      rules: selectedRules,
      cwd: '/app',
      additionalDirectories: [],
      rulesForTool: rulesForToolName(selectedRules, 'Bash'),
      toolUseId: 'shell-permission-regression',
    },
  );
}

describe('multiline cleanup permission decisions', () => {
  it.each([
    ['benchmark cleanup', benchmarkCleanup],
    ['broker cleanup', brokerCleanup],
  ])(
    '%s has the same safety finding with and without continuations',
    async (_name, command) => {
      for (const text of [command, command.replace(/\\\n/g, '')]) {
        const decision = checkShellPermission(
          { command: text, cwd: '/app' },
          { rules, additionalDirectories: [] },
          'Bash',
        );
        expect(decision.kind).toBe('ask');
        if (decision.kind === 'ask') {
          expect(decision.reason.decisionPoint).toBe(
            'shell.dangerous_command.ask',
          );
          expect(decision.reason.attribution).not.toHaveProperty(
            'bypassImmune',
            true,
          );
        }
        expect((await checkMode(text, PermissionModes.Default)).kind).toBe(
          'ask',
        );
        expect((await checkMode(text, PermissionModes.Yolo)).kind).toBe(
          'allow',
        );
        expect((await checkMode(text, PermissionModes.DontAsk)).kind).toBe(
          'deny',
        );
        expect(
          (
            await checkMode(text, PermissionModes.Yolo, {
              ...rules,
              deny: { localSettings: ['Bash(rm:*)'] },
            })
          ).kind,
        ).toBe('deny');
      }
    },
  );

  it.each(['rm -rf /', 'rm -rf /app', 'rm -rf $UNSET/*', 'echo "$(rm -rf /)"'])(
    'keeps catastrophic deletion protected under Yolo: %s',
    async (command) => {
      expect((await checkMode(command, PermissionModes.Yolo)).kind).toBe('ask');
    },
  );
});

describe('heredoc permissions respect authorization and mode', () => {
  it.each([
    "bash -c 'cat <<EOF\n$(rm -rf /app)\nEOF'",
    "printf '%s' 'rm -rf /app'; cat <<EOF\n$(rm -rf /app)\nEOF",
    "cat <<EOF\n$(rm -rf /app)\nEOF\nprintf '%s' 'rm -rf /app'",
    "bash -c 'printf \"%s\" \"rm -rf /app\"; cat <<EOF\n$(rm -rf /app)\nEOF'",
  ])('keeps executed heredoc substitutions protected under Yolo: %s', async (command) => {
    const result = await checkMode(command, PermissionModes.Yolo);
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution).toMatchObject({
        safetyCheckKind: 'dangerousRemoval',
        bypassImmune: true,
      });
    }
  });

  it.each([
    "printf '%s' 'rm -rf /app'; cat <<'EOF'\n$(rm -rf /app)\nEOF",
    'bash -c "cat <<\'EOF\'\n\\$(rm -rf /app)\nEOF"',
  ])('does not treat quoted heredoc data as an executed substitution: %s', async (command) => {
    expect((await checkMode(command, PermissionModes.Yolo)).kind).toBe('allow');
    expect(isDangerousShellCommand({ command })).toBeNull();
  });

  it.each([
    'bash <<EOF\nrm -rf /app\nEOF',
    "bash -c 'cat <<EOF\n`rm -rf /app`\nEOF'",
  ])('preserves bypass behavior for shell heredoc input: %s', async (command) => {
    expect((await checkMode(command, PermissionModes.Yolo)).kind).toBe('allow');
  });

  it('honors tool-level allow for SQL heredoc input in Default mode', async () => {
    const command = "mysql <<'SQL'\nDROP TABLE examples;\nSQL";
    expect(isDangerousShellCommand({ command })).toBeNull();
    expect(
      (
        await checkMode(command, PermissionModes.Default, {
          ...rules,
          allow: { localSettings: ['Bash'] },
        })
      ).kind,
    ).toBe('allow');
  });

  it.each([
    ["cat <<'EOF'\nhello\nEOF", 'allow'],
    ["python3 <<'EOF'\nprint('hello')\nEOF", 'deny'],
    ['bash <<EOF\nprintf hello\nEOF', 'deny'],
    ["cat <<'EOF' | bash\nprintf hello\nEOF", 'deny'],
    ["sed -n '1p' <<'EOF'\nhello\nEOF", 'allow'],
    ["cat <<'A' <<'B'\nhello\nA\nworld\nB", 'deny'],
  ])('%s', async (command, withoutAuthorization) => {
    expect((await checkMode(command, PermissionModes.DontAsk)).kind).toBe(
      withoutAuthorization,
    );
    expect((await checkMode(command, PermissionModes.Yolo)).kind).toBe('allow');
    for (const allow of ['Bash', `Bash(${command})`]) {
      expect(
        (
          await checkMode(command, PermissionModes.DontAsk, {
            ...rules,
            allow: { localSettings: [allow] },
          })
        ).kind,
      ).toBe('allow');
    }
    expect(
      (
        await checkMode(command, PermissionModes.Yolo, {
          ...rules,
          deny: { localSettings: ['Bash'] },
        })
      ).kind,
    ).toBe('deny');
  });
});

describe('dangerous operations retain their confirmation policy', () => {
  it.each([
    'rm -rf /tmp/scratch',
    'rm -r scratch',
    'rm -f scratch',
    'git reset --hard',
    'git push origin main --force',
    'git push --force-with-lease',
    'git clean -fd',
    'git checkout -- .',
    'git restore .',
    'git stash drop',
    'git stash clear',
    'git branch -D topic',
    'git commit --amend',
    'git commit --no-verify',
    'kubectl delete pod example',
    'terraform destroy',
    'mysql -e "DROP TABLE examples"',
    'psql -c "DELETE FROM examples;"',
    'python3 -c \'cursor.execute("DROP TABLE examples")\'',
    "bash -c 'git reset --hard'",
    'echo "$(git reset --hard)"',
  ])('detects %s', (command) => {
    expect(isDangerousShellCommand({ command })).not.toBeNull();
  });

  it.each([
    'git clean -nfd',
    'git status',
    "printf '%s' 'git reset --hard'",
    "grep 'git reset --hard' README.md",
    "git commit -m 'git reset --hard'",
    "git commit -m '--amend'",
    "git 'reset --hard'",
    "'git reset --hard'",
    '# git reset --hard\npwd',
  ])('does not mistake ordinary arguments for commands: %s', (command) => {
    expect(isDangerousShellCommand({ command })).toBeNull();
  });
});
