/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_FIXED_ENV_PREFIX } from '../../../config/brand.js';
import { EnvConfigService } from '../../../config-service/env-config-service.js';
import {
  installConfigService,
  stopConfigService,
} from '../../../config-service/index.js';
import { evaluateAutoReview } from './auto-review-policy.js';
import { AutoClassifierView } from './auto-classifier-view.js';
import { createAskHandler } from '../../ask-handler/ask-handler.js';
import { AutoClassifier } from './auto-classifier.js';
import { LlmAutoJudge } from './auto-judge.js';
import { createEmptyToolLookup } from './classifier.js';
import {
  createPermissionManager,
  checkWithOverride,
} from '../../../test-utils/config.js';
import { initializeShellParsers } from '../../../utils/shell-utils.js';
import { checkShellPermission } from '../../../tools/shell-permissions/shellPermissions.js';
import { checkPowerShellPermission } from '../../../tools/shell-permissions/powerShellPermissions.js';
import {
  parsePowerShellCommand,
  getAllParsedPowerShellCommands,
} from '../../../tools/shell-permissions/powerShellParser.js';
import { analyzePowerShellPaths } from '../../../tools/shell-permissions/powerShellPathValidation.js';
import {
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../../../utils/shell/powerShell.js';
import { MONITOR_TOOL_NAME } from '../../../tools/tool-names.js';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../manager/decision/index.js';
import type { ToolPermissionReason } from '../../../tools/tool-checkers/checker-reasons.js';
import type { ToolPermissionResult } from '../../../tools/tool-checkers/rule-precedence.js';

let cwd: string;
const emptyRules = (): PermissionRules => ({ allow: {}, ask: {}, deny: {} });
const ask: Extract<ToolPermissionResult, { kind: 'ask' }> = {
  kind: 'ask',
  reason: {
    message: 'Review',
    attribution: { type: 'other', reason: 'default' },
  },
};
function context(rules = emptyRules()): ToolCheckContext<ToolPermissionReason> {
  return {
    cwd,
    rules,
    mode: PermissionModes.Auto,
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, 'Bash'),
    toolUseId: 'review-test',
  };
}
beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'auto-review-')));
  mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true });
  await initializeShellParsers();
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('Auto command policy', () => {
  it.each([
    'rm file',
    'rmdir folder',
    'del file',
    'remove-item file',
    'rd folder',
    'erase file',
    'shred file',
    'unlink file',
    'deltree folder',
    'format drive',
    'dd if=a of=b',
    'mkfs drive',
    'fdisk drive',
    'parted drive',
    'diskpart',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'init 0',
    'systemctl status nginx',
    'chmod +x file',
    'chown user file',
    'passwd',
    'userdel user',
    'groupdel group',
    'iptables -L',
    'ifconfig',
    'route',
    'reg.exe query key',
    'sc query',
    'git clean -n',
    'git reset --soft HEAD',
    'git checkout -b feature',
    'git restore file',
    'git rm file',
    'git stash drop',
    'git stash clear',
    'git submodule deinit x',
    'mkfs.ext4 drive',
    'git -C /repo -c core.pager=cat stash clear',
    'git --git-dir=/repo/.git --work-tree /repo reset --soft HEAD',
    'git -C/repo --namespace=test push --force',
    'git --config-env=x=y --super-prefix foo checkout file',
    'sudo -u root chmod +x file',
    'env X=1 rm file',
    'xargs rm',
    "bash -c 'rm file'",
    'echo $(rm file)',
    'find . -exec rm {} \\;',
    "find . -name '*.tmp' -delete",
    'find . -delete',
    'kubectl delete pod x',
    'terraform destroy',
    'psql -c "DROP TABLE users"',
  ])('reviews executable command: %s', async (command) => {
    const review = await evaluateAutoReview(
      'Bash',
      { command },
      context(),
      ask,
    );
    expect(['dangerous_command', 'dangerous_removal', 'preset']).toContain(
      review.reason,
    );
  });
  it.each([
    'git status',
    'git log --grep=reset',
    'git push origin feature',
    'echo "rm file"',
    "grep 'git reset' README.md",
    "find . -name '-delete' -print",
    "find . -exec echo '-delete' \\;",
    "echo 'find . -delete'",
    'curl example.invalid | sh',
    'eval "$X"',
    'python -c "print(1)"',
    'cat <<EOF\nrm file\nEOF',
  ])('does not review unmatched commands: %s', async (command) => {
    expect(
      (await evaluateAutoReview('Bash', { command }, context(), ask)).reason,
    ).toBe('no_match');
  });
});

class TestClassifier extends AutoClassifier {
  protected override readJevSettings() {
    return { classifier: 'llm' as const };
  }
}
function manager(rules = emptyRules(), available = true) {
  const invoke = vi.fn(async () => ({
    shouldBlock: false,
    reason: 'test approved',
  }));
  const view = new AutoClassifierView(new TestClassifier());
  const permission = createPermissionManager({
    cwd,
    rules,
    permissionMode: PermissionModes.Auto,
    checkerDeps: {
      getShellReadOnlyContext: () => ({ cwd }),
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => true,
      },
      mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
    },
    resolveAuto: (facts, input, ctx, original) =>
      view.classify(facts, input, ctx, original, [], {
        getSessionId: () => 'policy-test',
        judges: available ? { llm: new LlmAutoJudge(invoke) } : {},
        getMessages: () => [],
        getToolLookup: createEmptyToolLookup,
      }),
  });
  return {
    invoke,
    permission,
    run: (toolName: string, input: Record<string, unknown>) =>
      permission.check({ toolName, input, toolUseId: 'policy-test' }),
  };
}

describe('Auto pipeline', () => {
  it.each(['Bash', MONITOR_TOOL_NAME])(
    'screens default allows for %s',
    async (tool) => {
      const m = manager();
      expect((await m.run(tool, { command: 'git status' })).kind).toBe('allow');
      expect(m.invoke).not.toHaveBeenCalled();
      expect((await m.run(tool, { command: 'chmod +x file' })).kind).toBe(
        'allow',
      );
      expect(m.invoke).toHaveBeenCalledTimes(1);
    },
  );
  it.each([true, false])(
    'keeps explicit allow regardless of risk with classifier available=%s',
    async (available) => {
      const m = manager(
        {
          ...emptyRules(),
          allow: { userSettings: ['Bash(chmod:*)'] },
        },
        available,
      );
      for (const risk of [false, true, undefined]) {
        const allowed = await m.run('Bash', {
          command: 'chmod +x file',
          ...(risk === undefined ? {} : { risk }),
        });
        expect(allowed.kind).toBe('allow');
        expect(allowed.toolCheck.extra).toMatchObject({
          explicitAllow: true,
          autoReview: { reason: 'explicit_allow' },
        });
      }
      expect(m.invoke).not.toHaveBeenCalled();
    },
  );
  it('lets model risk request review even for default readonly allows', async () => {
    const m = manager();
    await m.run('Bash', { command: 'echo safe', risk: true });
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it('preserves a matched ask and a deny ahead of risk', async () => {
    const m = manager({
      ...emptyRules(),
      ask: { userSettings: ['Bash(npm publish:*)'] },
      allow: { userSettings: ['Bash(npm publish:*)'] },
    });
    await m.run('Bash', { command: 'npm publish', risk: true });
    expect(m.invoke).toHaveBeenCalledTimes(1);
    const denied = manager({
      ...emptyRules(),
      deny: { userSettings: ['Bash'] },
      allow: { userSettings: ['Bash(echo safe)'] },
    });
    expect(
      (await denied.run('Bash', { command: 'echo safe', risk: true })).kind,
    ).toBe('deny');
    expect(denied.invoke).not.toHaveBeenCalled();
  });
  it('allows ordinary non-Shell asks but reviews sensitive writes', async () => {
    const m = manager();
    await m.run('Write', { file_path: join(cwd, 'out.txt'), content: 'x' });
    expect(m.invoke).not.toHaveBeenCalled();
    await m.run('Write', {
      file_path: join(cwd, '.git', 'hooks', 'pre-commit'),
      content: 'x',
    });
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps Read rule asks ahead of ordinary non-Shell allowance', async () => {
    const m = manager({ ...emptyRules(), ask: { userSettings: ['Read'] } });
    await m.run('Read', { file_path: join(cwd, 'out.txt') });
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['Bash', 'Write'])('preserves hook ask for %s', async (toolName) => {
    const m = manager();
    await checkWithOverride(
      m.permission,
      {
        toolName,
        toolUseId: 'hook-ask',
        input:
          toolName === 'Bash'
            ? { command: 'echo safe' }
            : { file_path: join(cwd, 'out.txt'), content: 'x' },
      },
      { preToolUseHookVerdict: { behavior: 'ask' } },
    );
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['echo safe', true],
    ['echo safe', false],
    ['chmod +x file', true],
    ['chmod +x file', false],
  ] as const)(
    'keeps effective hook allow for %s with classifier available=%s',
    async (command, available) => {
      const m = manager(emptyRules(), available);
      for (const risk of [false, true, undefined]) {
        const result = await checkWithOverride(
          m.permission,
          {
            toolName: 'Bash',
            toolUseId: 'hook-allow',
            input: { command, ...(risk === undefined ? {} : { risk }) },
          },
          { preToolUseHookVerdict: { behavior: 'allow' } },
        );
        expect(result.kind).toBe('allow');
        expect(m.invoke).not.toHaveBeenCalled();
        expect(result.toolCheck.extra).toMatchObject({
          explicitAllow: true,
          autoReview: { reason: 'explicit_allow' },
        });
      }
    },
  );
  it('offers the exact command when model risk turns a readonly allow into manual approval', async () => {
    const command = 'echo safe';
    expect(checkShellPermission({ command, cwd }, context(), 'Bash').kind).toBe(
      'allow',
    );
    const m = manager(emptyRules(), false);
    const result = await checkWithOverride(
      m.permission,
      {
        toolName: 'Bash',
        toolUseId: 'manual-risk',
        input: { command, risk: true },
      },
      {
        askHandler: async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: {
              message: `Allow Bash to run: ${command}?\n\nAuto mode could not evaluate this action; approval is required.`,
              decisionPoint: 'mode.auto_classifier_unavailable.keep_ask',
            },
            suggestions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: command }],
                behavior: 'allow',
                destination: 'localSettings',
              },
            ],
          });
          return { kind: 'approved' };
        },
      },
    );
    expect(result.kind).toBe('allow');
    expect(result.decidedBy).toBe('ask');
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it.each(['echo "*"', 'echo one\necho two'])(
    'does not offer an imprecise persistent grant for %s',
    async (command) => {
      expect(
        checkShellPermission({ command, cwd }, context(), 'Bash').kind,
      ).toBe('allow');
      const m = manager(emptyRules(), false);
      m.permission.setAskHandler(
        createAskHandler({
          present(prompt, settle) {
            expect(prompt.persistable).toBe(false);
            expect(prompt.suggestions).toEqual([]);
            settle({ kind: 'approved' });
            return () => {};
          },
        }),
      );
      const result = await m.run('Bash', { command, risk: true });
      expect(result.toolCheck).toMatchObject({
        kind: 'ask',
        reason: { decisionPoint: 'mode.auto_classifier_unavailable.keep_ask' },
        suggestions: [],
        extra: { persistable: false },
      });
      expect(result.kind).toBe('allow');
      expect(result.decidedBy).toBe('ask');
      expect(m.invoke).not.toHaveBeenCalled();
    },
  );
  it('does not let hook allow erase protectedPath', async () => {
    const m = manager();
    await checkWithOverride(
      m.permission,
      {
        toolName: 'Bash',
        toolUseId: 'hook-sensitive',
        input: { command: 'echo text > .git/hooks/pre-commit' },
      },
      { preToolUseHookVerdict: { behavior: 'allow' } },
    );
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps Monitor tool-level grants and local no-match independent of model availability', async () => {
    const m = manager(
      { ...emptyRules(), allow: { userSettings: [MONITOR_TOOL_NAME] } },
      false,
    );
    expect(
      (await m.run(MONITOR_TOOL_NAME, { command: 'chmod +x file' })).kind,
    ).toBe('allow');
    expect((await m.run('Bash', { command: 'echo safe' })).kind).toBe('allow');
    expect(m.invoke).not.toHaveBeenCalled();
  });
});

describe('configured Auto presets', () => {
  const key = `${BRAND_FIXED_ENV_PREFIX}CONFIG_AUTO_MODE_REVIEW_PRESETS`;
  const empty = {
    commands: [],
    git_subcommands: [],
    find_delete: false,
    mkfs_variants: false,
  };
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    environment = { [key]: JSON.stringify(empty) };
    installConfigService(new EnvConfigService({ environment }));
  });
  afterEach(() => stopConfigService());

  it('applies replacement, hot updates and fallback to the next approval', async () => {
    const m = manager();
    environment[key] = JSON.stringify({ ...empty, commands: ['docker'] });
    await m.run('Bash', { command: 'chmod +x file' });
    expect(m.invoke).not.toHaveBeenCalled();
    await m.run('Bash', { command: 'docker ps' });
    expect(m.invoke).toHaveBeenCalledTimes(1);
    environment[key] = JSON.stringify(empty);
    await m.run('Bash', { command: 'docker ps' });
    expect(m.invoke).toHaveBeenCalledTimes(1);
    environment[key] = 'invalid';
    await m.run('Bash', { command: 'chmod +x file' });
    expect(m.invoke).toHaveBeenCalledTimes(2);
    delete environment[key];
    await m.run('Bash', { command: 'git checkout -b feature' });
    expect(m.invoke).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['sudo /usr/bin/chmod +x file', { commands: ['chmod'] }, 'preset.chmod'],
    ['reg.exe query key', { commands: ['reg'] }, 'preset.reg'],
    [
      'git -C /repo fetch origin',
      { git_subcommands: [['fetch']] },
      'preset.git.fetch',
    ],
    [
      'git remote remove origin',
      { git_subcommands: [['remote', 'remove']] },
      'preset.git.remote.remove',
    ],
    ['find . -delete', { find_delete: true }, 'preset.find.delete'],
    ['mkfs.ext4 drive', { mkfs_variants: true }, 'preset.mkfs'],
  ] as const)(
    'configures the existing matching behavior: %s',
    async (command, config, ruleId) => {
      expect(
        (await evaluateAutoReview('Bash', { command }, context(), ask)).reason,
      ).toBe('no_match');
      environment[key] = JSON.stringify({ ...empty, ...config });
      expect(
        await evaluateAutoReview('Bash', { command }, context(), ask),
      ).toMatchObject({
        reason: 'preset',
        ruleId,
      });
    },
  );

  it('does not match ordinary text or a different Git subcommand', async () => {
    environment[key] = JSON.stringify({
      ...empty,
      commands: ['docker'],
      git_subcommands: [['remote', 'remove']],
      find_delete: true,
    });
    for (const command of [
      'echo docker',
      'git remote add origin url',
      "find . -name '-delete' -print",
    ]) {
      expect(
        (await evaluateAutoReview('Bash', { command }, context(), ask)).reason,
      ).toBe('no_match');
    }
  });

  it('keeps risk, rule asks and dangerous checks with empty presets', async () => {
    const m = manager({
      ...emptyRules(),
      ask: { userSettings: ['Bash(npm publish:*)'] },
    });
    for (const input of [
      { command: 'echo safe', risk: true },
      { command: 'npm publish' },
      { command: 'git push --force' },
      { command: 'rmdir .' },
      { command: 'echo text > .git/hooks/pre-commit' },
    ]) {
      await m.run('Bash', input);
    }
    expect(m.invoke).toHaveBeenCalledTimes(5);
  });
});

describe('Bash partial write targets', () => {
  it.each([
    'echo x > out.txt; echo y > .git/hooks/pre-commit',
    'echo y > .git/hooks/pre-commit; echo x > out.txt',
    'echo x > $T; echo y > .git/hooks/pre-commit',
    'echo y > .git/hooks/pre-commit; echo x > $T',
    'cat > .git/hooks/pre-commit <<EOF\nrm -rf x > "$LOG"\nEOF',
    'cat > .git/hooks/pre-commit <<EOF\necho x > "$LOG"\nEOF',
  ])('retains protectedPath: %s', async (command) => {
    const result = checkShellPermission(
      { command, cwd },
      context(),
      'Bash',
      undefined,
      true,
    );
    expect(result).toMatchObject({
      kind: 'ask',
      reason: {
        attribution: { type: 'safetyCheck', safetyCheckKind: 'protectedPath' },
      },
    });
    const m = manager();
    await m.run('Bash', { command });
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    'echo x > $T; echo y > blocked.txt',
    'echo y > blocked.txt; echo x > $T',
  ])(
    'checks static denied paths even when a sibling is dynamic: %s',
    (command) => {
      const rules = {
        ...emptyRules(),
        deny: { userSettings: ['Edit(/' + join(cwd, 'blocked.txt') + ')'] },
      };
      expect(
        checkShellPermission(
          { command, cwd },
          context(rules),
          'Bash',
          undefined,
          true,
        ).kind,
      ).toBe('deny');
      expect(
        checkShellPermission({ command, cwd }, context(rules), 'Bash').kind,
      ).toBe('ask');
    },
  );
  it('keeps the old unknown-target ask outside Auto', () => {
    const command = 'echo x > .git/hooks/pre-commit; echo y > $T';
    expect(
      checkShellPermission({ command, cwd }, context(), 'Bash'),
    ).toMatchObject({
      kind: 'ask',
      reason: { decisionPoint: 'shell.write_target_unknown.ask' },
    });
  });
  it.each(['echo x > $T', 'echo x > out.txt; echo y > $T'])(
    'does not review unknown targets alone: %s',
    async (command) => {
      const m = manager();
      expect((await m.run('Bash', { command })).kind).toBe('allow');
      expect(m.invoke).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
  'PowerShell native AST Auto policy',
  () => {
    beforeAll(() =>
      _setPowerShellRuntimeForTest({
        executable: process.env['CLI_TEST_PWSH_EXE']!,
        edition: 'core',
      }),
    );
    afterAll(() => _resetPowerShellRuntimeForTest());
    it.each([
      'Set-Content .git/hooks/pre-commit $p',
      'Set-Content -Value $p -Path .git/hooks/pre-commit',
      'Set-Content .git/hooks/pre-commit "rm -rf $HOME"',
      'Set-Content -Encoding $enc -Path .git/hooks/pre-commit -Value text',
      'Add-Content .git/hooks/pre-commit $p',
      'Out-File -InputObject $p -FilePath .git/hooks/pre-commit',
      'Tee-Object -InputObject $p -FilePath .git/hooks/pre-commit',
      'Set-Content .git/hooks/pre-commit $p > $log',
      'Set-Content out.txt $p > .git/hooks/pre-commit',
      'Write-Output text > $log 2> .git/hooks/pre-commit',
      'Write-Output text 2> .git/hooks/pre-commit > $log',
    ])(
      'keeps independent static targets and the issue: %s',
      async (command) => {
        const parsed = await parsePowerShellCommand(command);
        expect(parsed.errors).toEqual([]);
        const entry = getAllParsedPowerShellCommands(parsed)[0];
        const paths = analyzePowerShellPaths(entry, cwd, false, true);
        expect(paths.targets).toContainEqual({
          path: join(cwd, '.git/hooks/pre-commit'),
          access: 'write',
        });
        expect(paths.issue).toBeTruthy();
        expect(paths.acceptEditsEligible).toBe(false);
        expect(
          await checkPowerShellPermission(
            { command, permissionCwd: cwd },
            context(),
            'PowerShell',
            true,
          ),
        ).toMatchObject({
          kind: 'ask',
          reason: { attribution: { safetyCheckKind: 'protectedPath' } },
        });
        const m = manager();
        await m.run('PowerShell', { command });
        expect(m.invoke).toHaveBeenCalledTimes(1);
      },
    );
    it.each([
      'Remove-Item file',
      'rm file',
      'git -C /repo reset --soft HEAD',
      'reg.exe query key',
    ])('reviews native commands: %s', async (command) => {
      expect(
        (await evaluateAutoReview('PowerShell', { command }, context(), ask))
          .reason,
      ).not.toBe('no_match');
    });
    it('allows ordinary dynamic content but keeps the original issue outside Auto', async () => {
      const command = 'Set-Content out.txt $p';
      const m = manager();
      expect((await m.run('PowerShell', { command })).kind).toBe('allow');
      expect(m.invoke).not.toHaveBeenCalled();
      const parsed = await parsePowerShellCommand(command);
      expect(
        analyzePowerShellPaths(getAllParsedPowerShellCommands(parsed)[0], cwd),
      ).toMatchObject({
        targets: [],
        issue: expect.any(String),
        acceptEditsEligible: false,
      });
    });
    it('does not reinterpret a conflicting path binding', async () => {
      const command =
        'Set-Content -Value $p -Path .git/hooks/pre-commit -LiteralPath out.txt';
      const parsed = await parsePowerShellCommand(command);
      const paths = analyzePowerShellPaths(
        getAllParsedPowerShellCommands(parsed)[0],
        cwd,
        false,
        true,
      );
      expect(paths.targets).toEqual([]);
      expect(paths.issue).toBeTruthy();
    });
    it('checks static path denies before an unresolved content issue', async () => {
      const rules = {
        ...emptyRules(),
        deny: { userSettings: ['Edit(/' + join(cwd, 'blocked.txt') + ')'] },
      };
      const result = await checkPowerShellPermission(
        {
          command: 'Set-Content blocked.txt $p > $log',
          permissionCwd: cwd,
        },
        context(rules),
        'PowerShell',
        true,
      );
      expect(result.kind).toBe('deny');
    });
    it('preserves only whole-call rule allows, not mixed rule and readonly coverage', async () => {
      const m = manager({
        ...emptyRules(),
        allow: { userSettings: ['PowerShell(git checkout:*)'] },
      });
      await m.run('PowerShell', { command: 'git checkout -b feature' });
      expect(m.invoke).not.toHaveBeenCalled();
      await m.run('PowerShell', {
        command: 'git checkout -b feature; Write-Output done',
      });
      expect(m.invoke).toHaveBeenCalledTimes(1);
    });
    it('does not review an ordinary copy/Git combination just for the combination warning', async () => {
      const m = manager();
      await m.run('PowerShell', {
        command: 'Copy-Item out.txt backup.txt; git status',
      });
      expect(m.invoke).not.toHaveBeenCalled();
    });
  },
);
