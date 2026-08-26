from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected exactly one match, found {count}: {old[:100]!r}"
        )
    p.write_text(text.replace(old, new, 1))


config_path = "packages/core/src/utils/git-config-safety.ts"
replace_once(
    config_path,
    "const PROBE_FAILED: LocalGitConfigRisk = {\n  diffExternal: true,\n  diffDriverCommand: true,\n  diffDriverTextconv: true,\n  fsmonitor: true,\n};\n",
    "const PROBE_FAILED: LocalGitConfigRisk = {\n  diffExternal: true,\n  diffDriverCommand: true,\n  diffDriverTextconv: true,\n  fsmonitor: true,\n};\n\nconst DIFF_DRIVER_COMMAND_KEY_PATTERN = String.raw`^diff\\..*\\.command$`;\nconst DIFF_DRIVER_TEXTCONV_KEY_PATTERN = String.raw`^diff\\..*\\.textconv$`;\nconst LOCAL_GIT_CONFIG_RISK_KEY_PATTERN = [\n  String.raw`^diff\\.external$`,\n  String.raw`^core\\.fsmonitor$`,\n  DIFF_DRIVER_COMMAND_KEY_PATTERN,\n  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,\n].join('|');\nconst DIFF_DRIVER_COMMAND_KEY = new RegExp(\n  DIFF_DRIVER_COMMAND_KEY_PATTERN,\n  'i',\n);\nconst DIFF_DRIVER_TEXTCONV_KEY = new RegExp(\n  DIFF_DRIVER_TEXTCONV_KEY_PATTERN,\n  'i',\n);\n",
)
replace_once(
    config_path,
    "      '^diff\\\\.external$|^core\\\\.fsmonitor$|^diff\\\\..*\\\\.command$|^diff\\\\..*\\\\.textconv$',",
    "      LOCAL_GIT_CONFIG_RISK_KEY_PATTERN,",
)
replace_once(
    config_path,
    "  const hasLocalValueMatching = (pattern: RegExp): boolean =>\n    [...effective.entries()].some(\n      ([key, entry]) =>\n        pattern.test(key) &&\n        (entry.scope === 'local' || entry.scope === 'worktree') &&\n        entry.value.trim() !== '',\n    );",
    "  const hasLocalValueMatching = (pattern: RegExp): boolean =>\n    [...effective.keys()].some(\n      (key) => pattern.test(key) && (localValue(key) ?? '') !== '',\n    );",
)
replace_once(
    config_path,
    "    diffDriverCommand: hasLocalValueMatching(/^diff\\..+\\.command$/i),\n    diffDriverTextconv: hasLocalValueMatching(/^diff\\..+\\.textconv$/i),",
    "    diffDriverCommand: hasLocalValueMatching(DIFF_DRIVER_COMMAND_KEY),\n    diffDriverTextconv: hasLocalValueMatching(DIFF_DRIVER_TEXTCONV_KEY),",
)

parser_path = "packages/core/src/utils/shellAstParser.ts"
replace_once(
    parser_path,
    "    if (!['diff', 'log', 'show', 'status'].includes(subcommand)) continue;",
    "    if (!['blame', 'diff', 'log', 'show', 'status'].includes(subcommand))\n      continue;",
)
replace_once(
    parser_path,
    "    usesTextconvConsumer ||= ['diff', 'log', 'show'].includes(subcommand);",
    "    usesTextconvConsumer ||= ['blame', 'diff', 'log', 'show'].includes(\n      subcommand,\n    );",
)

test_path = "packages/core/src/utils/shellAstParser.test.ts"
anchor = "    it('fails closed instead of simulating a changed directory', async () => {"
tests = r'''    it('downgrades git diff for diff-driver commands without over-downgrading log/show', async () => {
      const cwd = createRepo();
      gitConfig(cwd, 'diff.pwn.command', 'example-diff-command');

      expect(await isShellCommandReadOnlyASTInDirectory('git diff', cwd)).toBe(
        false,
      );
      expect(
        await isShellCommandReadOnlyASTInDirectory('git log -p -1', cwd),
      ).toBe(true);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git show HEAD', cwd),
      ).toBe(true);
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);
    });

    it('downgrades diff/log/show/blame when a textconv driver is configured', async () => {
      const cwd = createRepo();
      gitConfig(cwd, 'diff.pwn.textconv', 'example-textconv');

      for (const command of [
        'git diff',
        'git log -p -1',
        'git show HEAD',
        'git blame file.txt',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          false,
        );
      }
      expect(
        await isShellCommandReadOnlyASTInDirectory('git status', cwd),
      ).toBe(true);
    });

    it('handles empty diff-driver subsection names conservatively', async () => {
      const commandCwd = createRepo();
      gitConfig(commandCwd, 'diff..command', 'example-diff-command');
      expect(
        await isShellCommandReadOnlyASTInDirectory('git diff', commandCwd),
      ).toBe(false);

      const textconvCwd = createRepo();
      gitConfig(textconvCwd, 'diff..textconv', 'example-textconv');
      for (const command of [
        'git diff',
        'git log -p -1',
        'git show HEAD',
        'git blame file.txt',
      ]) {
        expect(
          await isShellCommandReadOnlyASTInDirectory(command, textconvCwd),
        ).toBe(false);
      }
    });

    it('ignores empty diff-driver helper values', async () => {
      const cwd = createRepo();
      gitConfig(cwd, 'diff.pwn.command', '');
      gitConfig(cwd, 'diff.pwn.textconv', '');

      for (const command of [
        'git diff',
        'git log -p -1',
        'git show HEAD',
        'git blame file.txt',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          true,
        );
      }
    });

    it('keeps diff-driver config gates in regex fallback mode', async () => {
      const commandCwd = createRepo();
      gitConfig(commandCwd, 'diff.pwn.command', 'example-diff-command');
      const textconvCwd = createRepo();
      gitConfig(textconvCwd, 'diff.pwn.textconv', 'example-textconv');

      _setParserFailedForTesting();
      try {
        expect(
          await isShellCommandReadOnlyASTInDirectory('git diff', commandCwd),
        ).toBe(false);
        expect(
          await isShellCommandReadOnlyASTInDirectory('git diff', textconvCwd),
        ).toBe(false);
      } finally {
        _resetParser();
        await initParser();
      }
    });

    it('keeps ordinary read-only Git commands read-only without diff-driver helpers', async () => {
      const cwd = createRepo();

      for (const command of [
        'git diff',
        'git log -1',
        'git show HEAD',
        'git blame file.txt',
      ]) {
        expect(await isShellCommandReadOnlyASTInDirectory(command, cwd)).toBe(
          true,
        );
      }
    });

'''
p = Path(test_path)
text = p.read_text()
if text.count(anchor) != 1:
    raise SystemExit(
        f"{test_path}: expected one insertion anchor, found {text.count(anchor)}"
    )
p.write_text(text.replace(anchor, tests + anchor, 1))
