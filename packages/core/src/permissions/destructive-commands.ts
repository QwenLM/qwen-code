/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deterministic pre-filter for destructive git and IaC commands in AUTO mode.
 *
 * Runs BEFORE the L5.3 LLM classifier as a Layer 0 guard. The classifier is
 * non-deterministic and can fail due to API unavailability, timeout, or poor
 * judgment on ambiguous prompts like "clean up the git state". This module
 * reads the command the way the shell runs it (the tree-sitter bash parser)
 * and blocks the protected operations it executes, whatever the classifier
 * would say on the denying call: the block is hard until denial tracking
 * reaches the consecutive-block or session-total cap, at which point
 * `applyAutoModeDecision` escalates to a confirmation only a human can give —
 * it marks the escalation `requiresHumanDecision`, so a `PermissionRequest`
 * hook returning `allow` cannot waive it. Wording in the user's prompt never
 * lifts it; an explicit `permissions.ask` rule turns it into that human-only
 * confirmation instead.
 *
 * Only applies in AUTO mode — YOLO mode is an explicit opt-out of all guards.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import type Parser from 'web-tree-sitter';
import { parseShellCommand } from '../utils/shellAstParser.js';

type SyntaxNode = Parser.SyntaxNode;

/** Result of a destructive command check. */
export interface DestructiveCommandResult {
  blocked: boolean;
  reason: string;
}

// ─── Session commit tracking (for git commit --amend) ─────────────────────

const sessionCommitShas = new Set<string>();

/**
 * Bumped by every `clearSessionCommits()` so a writer that decided to
 * register *before* a clear can tell that the registry it is about to
 * write into is not the one it decided against.
 *
 * The deferred writer this exists for is the Ctrl+B promote path in
 * `shell.ts`: it registers when the backgrounded child exits,
 * arbitrarily later than the promote, and an approval-mode transition
 * in between clears the registry on purpose (`Config.setApprovalMode`,
 * whose stated contract is that exemptions must not carry across that
 * boundary). Without a generation check the settle writes the exemption
 * straight back.
 *
 * Deliberately not `Config.getApprovalModeRevision()`: that counter
 * moves on every mode change, including the AUTO → PLAN → AUTO
 * excursion `clearSessionCommits()` is explicitly gated off, so it
 * would drop registrations the clear never touched.
 */
let sessionCommitGeneration = 0;

/** The registry generation counter; see `sessionCommitGeneration`. */
export function getSessionCommitGeneration(): number {
  return sessionCommitGeneration;
}

/**
 * Register a commit SHA made by the agent during this session.
 * Used to allow `git commit --amend` when the target commit was made
 * by the agent in the current session.
 */
export function registerSessionCommit(sha: string): void {
  sessionCommitShas.add(sha.trim());
}

/**
 * Check whether a `git commit --amend` targets a commit made this session.
 * Reads the current HEAD commit SHA and checks against registered session commits.
 */
export function isAmendOfSessionCommit(cwd: string): boolean {
  if (sessionCommitShas.size === 0) return false;
  try {
    const headSha = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sessionCommitShas.has(headSha);
  } catch {
    return false;
  }
}

/**
 * Clear all session commit tracking. Called on session end or mode switch.
 * Also bumps the generation counter, which is how a deferred writer
 * learns that the registry it decided against no longer exists.
 */
export function clearSessionCommits(): void {
  sessionCommitShas.clear();
  sessionCommitGeneration++;
}

// ─── Command analysis ─────────────────────────────────────────────────────

/** Stands in for the part of a word the shell only computes at run time. */
const DYNAMIC = '\0';
/** An unquoted expansion, which the shell may split into any number of words. */
const SPLIT = '\u0001';

const words = (list: string) => new Set(list.split(' '));

const IAC_TOOLS = words('terraform pulumi cdk');
const SHELLS = words('sh bash zsh dash ksh fish');
/** Run code in another language, which the guard cannot read. */
const INTERPRETER = /^(?:python[\d.]*|node|perl|ruby|php|[gmn]?awk)$/;
const SHELL_OPTIONS_WITH_VALUE = words('-o +o -O +O --rcfile --init-file');
/** Run the rest of their arguments as one script. */
const SCRIPT_RUNNERS = words('eval cmd powershell pwsh');
const DIRECTORY_CHANGES = words('cd pushd popd');
/** Only read their arguments as data: text to print, patterns, files. */
const DATA_ONLY = words(
  'echo printf grep egrep fgrep zgrep rg ag ack cat less more head tail wc sort uniq cut nl jq diff ls stat file test [',
);

interface Wrapper {
  /** Options whose value is the next word. */
  value?: string;
  /** Options whose value is a command line to run. */
  script?: string;
  /** Operands before the command: `timeout`'s duration, `flock`'s file. */
  skip?: number;
  /** Runs nothing unless given a `script` option. */
  scriptOnly?: boolean;
  /** Joins the command words into one shell command line. */
  joins?: boolean;
}

/** Programs that run the command in their argv, and how to find it. */
const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    value:
      '-u --user -g --group -C --close-from -D --chdir -p --prompt -r --role -t --type -T --command-timeout -U --other-user -h --host',
  },
  doas: { value: '-u -C' },
  env: { value: '-u --unset -C --chdir', script: '-S --split-string' },
  nice: { value: '-n --adjustment' },
  ionice: { value: '-c --class -n --classdata' },
  nohup: {},
  setsid: {},
  unbuffer: {},
  chronic: {},
  exec: { value: '-a' },
  time: { value: '-f --format -o --output' },
  timeout: { value: '-s --signal -k --kill-after', skip: 1 },
  stdbuf: { value: '-i --input -o --output -e --error' },
  flock: {
    value: '-w --wait --timeout -E --conflict-exit-code',
    script: '-c --command',
    skip: 1,
  },
  xargs: {
    value:
      '-a --arg-file -d --delimiter -E --eof -I -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var',
  },
  npx: { value: '-p --package', script: '-c --call' },
  watch: { value: '-n --interval -q --equexit', joins: true },
  su: {
    value: '-g --group -G --supp-group -s --shell -w --whitelist-environment',
    script: '-c --command',
    scriptOnly: true,
  },
  script: {
    value: '-E --echo -I --log-in -O --log-out -T --log-timing',
    script: '-c --command',
    scriptOnly: true,
  },
};
const GIT_GLOBAL_OPTIONS_WITH_VALUE = words(
  '-C -c --git-dir --work-tree --namespace --super-prefix --config-env --attr-source',
);
const GIT_REPOSITORY_VARIABLES = words('GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR');
/** Same bound as the shell-wrapper unwrapping in `shell-semantics.ts`. */
const MAX_SCRIPT_DEPTH = 4;

const PROTECTED_OPERATIONS = words('reset checkout clean stash commit destroy');
const PROTECTED_OPERATION = new RegExp(
  `\\b(?:${[...PROTECTED_OPERATIONS].join('|')})\\b`,
);
// Whole words only: `git-clean.sh`, `.git/` and `reset.ts` name files.
const PROTECTED_PROGRAM = /(?<![\w.-])(?:git|terraform|pulumi|cdk)(?![\w./-])/;
/** Text that may spell a protected operation; a commit only when amended. */
const MENTIONED_OPERATION =
  /(?<![\w./-])(?:reset|checkout|clean|stash|destroy|amend)(?![\w./-])|--am/;

/** A pathspec that resolves to the current directory or one of its parents. */
const WHOLE_TREE_PATHSPEC = /^\.\.?(?:\/+(?:\.\.?)?)*$/;

const AMEND_REASON =
  'Blocked "git commit --amend": the commit it would rewrite could not be verified as one the agent made in this session.';
const UNVERIFIABLE_REASON =
  'Blocked shell command: AUTO mode could not verify whether it runs a destructive git or infrastructure-destroy command. Write it as plain commands with literal arguments so it can be checked.';

interface Script {
  text: string;
  /** Directory the script starts in; undefined when it cannot be known. */
  cwd: string | undefined;
  depth: number;
  /**
   * Spans of `text` that cannot feed hidden code: comments, git and IaC
   * commands checked word for word, and text run as a nested script, which
   * is weighed on its own.
   */
  checked: Array<[number, number]>;
}

interface Scan {
  /** The command itself, then every nested script it runs. */
  scripts: Script[];
  found?: string;
  /** Directory of each `git commit --amend`; undefined when unknown. */
  amendTargets: Array<string | undefined>;
  /** A cd or repository variable may point a later git command elsewhere. */
  movesRepository: boolean;
  unverifiable: boolean;
  /**
   * The command runs code the guard cannot read: a script file, a program a
   * shell reads from a pipe or file, interpreter code, a git setting, or a
   * program built at run time.
   */
  hiddenCode: boolean;
}

interface CommandContext {
  node: SyntaxNode;
  /** The script the command belongs to. */
  script: Script;
  cwd: string | undefined;
}

/**
 * Check whether a shell command runs a protected destructive operation.
 * Printed text, comments and other data never count. A command the guard
 * cannot parse, or one that runs code it cannot read (a program or
 * arguments built at run time, a script file, interpreter code), is blocked
 * too when its text mentions a protected program and operation outside the
 * commands the guard checked.
 *
 * @param command - The shell command string
 * @param cwd - Directory the command runs in (amend check); without it an
 *   amend is never exempt
 * @returns Block result if the command is destructive, null otherwise
 */
export async function isDestructiveCommand(
  command: string,
  cwd?: string,
): Promise<DestructiveCommandResult | null> {
  const scan: Scan = {
    scripts: [{ text: command, cwd, depth: 0, checked: [] }],
    amendTargets: [],
    movesRepository: false,
    unverifiable: false,
    hiddenCode: false,
  };
  for (let i = 0; i < scan.scripts.length && !scan.found; i++) {
    await scanScript(scan.scripts[i]!, scan);
  }
  // Hidden code can come from anywhere in the command: text it prints,
  // writes to a file or keeps in a variable.
  if (scan.hiddenCode) {
    for (const { text, checked } of scan.scripts) {
      let rest = text;
      for (const [start, end] of checked) {
        rest = rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end);
      }
      flagIfMayRunProtected(rest, scan);
    }
  }

  if (scan.found) {
    return {
      blocked: true,
      reason: scan.found.startsWith('git ')
        ? `Blocked destructive git command: "${scan.found}".`
        : `Blocked infrastructure destroy command: "${scan.found}".`,
    };
  }
  if (
    scan.amendTargets.length > 0 &&
    (scan.movesRepository ||
      !scan.amendTargets.every(
        (dir) => dir !== undefined && isAmendOfSessionCommit(dir),
      ))
  ) {
    return { blocked: true, reason: AMEND_REASON };
  }
  if (scan.unverifiable) {
    return { blocked: true, reason: UNVERIFIABLE_REASON };
  }
  return null;
}

async function scanScript(script: Script, scan: Scan): Promise<void> {
  if (script.depth > MAX_SCRIPT_DEPTH) {
    flagIfMayRunProtected(script.text, scan);
    return;
  }
  let tree: Parser.Tree;
  try {
    tree = await parseShellCommand(script.text);
  } catch {
    flagIfMayRunProtected(script.text, scan);
    return;
  }
  try {
    if (tree.rootNode.hasError) flagIfMayRunProtected(script.text, scan);
    const stack: SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'command') {
        visitCommand(node, script, scan);
      } else if (node.type === 'comment') {
        script.checked.push([node.startIndex, node.endIndex]);
      } else if (
        node.type === 'variable_assignment' &&
        GIT_REPOSITORY_VARIABLES.has(node.childForFieldName('name')?.text ?? '')
      ) {
        scan.movesRepository = true;
      } else if (
        node.type === 'command_substitution' &&
        node.text.startsWith('`') &&
        node.text.includes('\\`')
      ) {
        // The parser does not model backquotes nested inside backquotes.
        flagIfMayRunProtected(node.text, scan);
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        stack.push(node.namedChild(i)!);
      }
    }
  } finally {
    tree.delete();
  }
}

function visitCommand(node: SyntaxNode, script: Script, scan: Scan): void {
  const name = node.childForFieldName('name');
  if (!name) return;
  const args = argumentNodes(node);
  const argv = [wordOf(name), ...args.map(wordOf)];
  const program = programName(argv[0]!);
  if (
    (program === 'git' || IAC_TOOLS.has(program)) &&
    !argv.some((word) => isDynamic(word))
  ) {
    // Checked word for word, so the words naming its operation are no sign
    // of hidden code. Its other arguments stay: it may print them, as a
    // commit message or a log format.
    let i = 1;
    while (i < argv.length && argv[i]!.startsWith('-')) {
      if (program === 'git' && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(argv[i]!)) {
        i++;
      }
      i++;
    }
    const subcommand = args[Math.min(i, args.length) - 1];
    script.checked.push([node.startIndex, (subcommand ?? name).endIndex]);
  }
  runArgv(argv, { node, script, cwd: script.cwd }, scan);
}

function argumentNodes(node: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === 'argument') nodes.push(node.child(i)!);
  }
  return nodes;
}

/**
 * The word the shell passes, with run-time parts replaced by `DYNAMIC`, or
 * `SPLIT` when the shell may turn it into several words.
 */
function wordOf(node: SyntaxNode): string {
  // Brace expansion (`{.,src}`) turns one word into several; the parser
  // only marks the `{1..3}` form.
  if (
    (node.type === 'word' || node.type === 'concatenation') &&
    /\{[^{}]*,[^{}]*\}/.test(node.text)
  ) {
    return SPLIT;
  }
  switch (node.type) {
    case 'command_name':
      return node.firstNamedChild ? wordOf(node.firstNamedChild) : DYNAMIC;
    case 'word':
      if (node.text.startsWith('~')) return DYNAMIC;
      return node.text.replace(/\\(\n|.)/g, (_, c: string) =>
        c === '\n' ? '' : c,
      );
    case 'number':
      return node.text;
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'ansi_c_string':
      return node.text.includes('\\') ? DYNAMIC : node.text.slice(2, -1);
    case 'string':
      return node.namedChildren
        .map((part) =>
          part.type === 'string_content'
            ? part.text.replace(/\\([$`"\\\n])/g, (_, c: string) =>
                c === '\n' ? '' : c,
              )
            : DYNAMIC,
        )
        .join('');
    case 'concatenation': {
      const parts = node.namedChildren.map(wordOf);
      return parts.some((part) => part.includes(SPLIT))
        ? SPLIT
        : parts.join('');
    }
    default:
      // Unquoted expansions and substitutions.
      return SPLIT;
  }
}

/** The part of a word known before the command runs. */
function literalOf(word: string): string {
  for (let i = 0; i < word.length; i++) {
    if (word[i] === DYNAMIC || word[i] === SPLIT) return word.slice(0, i);
  }
  return word;
}

function isDynamic(word: string): boolean {
  return literalOf(word) !== word;
}

function programName(word: string): string {
  return word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/** Programs whose arguments this guard interprets itself. */
function isInterpreted(word: string): boolean {
  if (isDynamic(word)) return false;
  const name = programName(word);
  return (
    name === 'git' ||
    IAC_TOOLS.has(name) ||
    SHELLS.has(name) ||
    INTERPRETER.test(name) ||
    SCRIPT_RUNNERS.has(name) ||
    DIRECTORY_CHANGES.has(name)
  );
}

function runArgv(argv: string[], ctx: CommandContext, scan: Scan): void {
  const [head = '', ...args] = argv;
  if (isDynamic(head)) {
    // e.g. `$GIT reset --hard`: the program is only known at run time.
    scan.hiddenCode = true;
    if (args.some((arg) => PROTECTED_OPERATIONS.has(arg))) {
      scan.unverifiable = true;
    }
    return;
  }
  const program = programName(head);
  if (program === 'git') return checkGit(args, ctx, scan);
  if (IAC_TOOLS.has(program)) return checkIac(program, args, scan);
  if (SHELLS.has(program)) return checkShell(args, ctx, scan);
  if (SCRIPT_RUNNERS.has(program)) {
    return runScript(args.join(' '), ctx, scan, args);
  }
  if (DIRECTORY_CHANGES.has(program)) {
    scan.movesRepository = true;
    return;
  }
  if (DATA_ONLY.has(program)) return;
  if (program === 'command' || program === 'builtin') {
    // Run the rest, builtins such as `.` included; `command -v` only looks
    // the name up.
    const start = args.findIndex((arg) => !arg.startsWith('-'));
    if (start < 0 || args.slice(0, start).some((arg) => /[vV]/.test(arg))) {
      return;
    }
    return runArgv(args.slice(start), ctx, scan);
  }
  if (INTERPRETER.test(program) || program === '.' || program === 'source') {
    scan.hiddenCode = true;
    return;
  }
  // A program file, which may be a script, or one about to become runnable.
  if (head.includes('/') || program === 'chmod') scan.hiddenCode = true;
  if (program === 'find') return runFindCommands(args, ctx, scan);
  const wrapper = WRAPPERS[program];
  if (wrapper) return runWrapped(program, wrapper, args, ctx, scan);
  // An unknown program may still wrap a command the guard interprets.
  for (let i = 1; i < argv.length; i++) {
    if (isInterpreted(argv[i]!)) {
      runArgv(argv.slice(i), { ...ctx, cwd: undefined }, scan);
    }
  }
}

/** Checks the command a wrapper runs, possibly from another directory. */
function runWrapped(
  program: string,
  wrapper: Wrapper,
  args: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
  const withValue = words(wrapper.value ?? '');
  const scriptOptions = words(wrapper.script ?? '');
  const inner = { ...ctx, cwd: undefined };
  let replace: string | undefined;
  let skipped = 0;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      i++;
      break;
    }
    // `env FOO=1 cmd`, `sudo FOO=1 cmd`.
    if (/^[A-Za-z_]\w*=/.test(arg)) continue;
    if (!literalOf(arg).startsWith('-') || arg === '-') {
      // Operands before the command; options may follow them.
      if (skipped++ < (wrapper.skip ?? 0)) continue;
      break;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const attached = name.length > 2 && !name.startsWith('--');
    const short = attached ? name.slice(0, 2) : name;
    if (scriptOptions.has(short) || scriptOptions.has(name)) {
      // `env -S 'cmd args'`, `flock -c 'cmd'`: the value is a command line.
      const value =
        equals >= 0
          ? arg.slice(equals + 1)
          : attached
            ? arg.slice(2)
            : (args[++i] ?? '');
      const line = [value, ...args.slice(i + 1)];
      return runScript(line.join(' '), inner, scan, [arg, ...line]);
    }
    if (
      program === 'xargs' &&
      (short === '-I' || short === '-i' || name === '--replace')
    ) {
      replace =
        equals >= 0
          ? arg.slice(equals + 1)
          : attached
            ? arg.slice(2)
            : short === '-I'
              ? args[i + 1]
              : '{}';
    }
    if (equals < 0 && !attached && withValue.has(name)) i++;
  }
  if (wrapper.scriptOnly) return;
  const command = args.slice(i);
  if (command.length === 0) return;
  if (wrapper.joins) {
    return runScript(command.join(' '), inner, scan, command);
  }
  if (program === 'xargs') {
    // It fills in what it reads where the replacement string stands, else
    // appends it.
    const marked = command.map((word) =>
      word.replaceAll(replace ?? '{}', DYNAMIC),
    );
    if (replace === undefined) marked.push(SPLIT);
    return runArgv(marked, inner, scan);
  }
  runArgv(command, inner, scan);
}

/** `find -exec cmd {} ;` runs `cmd` with each found path where `{}` stands. */
function runFindCommands(
  args: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!)) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
    const command = args
      .slice(i + 1, end)
      .map((word) => word.replaceAll('{}', DYNAMIC));
    if (command.length > 0) runArgv(command, { ...ctx, cwd: undefined }, scan);
    i = end;
  }
}

function checkGit(args: string[], ctx: CommandContext, scan: Scan): void {
  let dir = ctx.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    const literal = literalOf(arg);
    if (!literal.startsWith('-')) break;
    const equals = literal.indexOf('=');
    const option = equals < 0 ? literal : literal.slice(0, equals);
    if (!GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      // Unknown effect on which repository the command reaches.
      dir = undefined;
      continue;
    }
    const value = equals < 0 ? (args[++i] ?? '') : arg.slice(equals + 1);
    // A split value can push other words in front of the subcommand.
    if (value.includes(SPLIT)) flagIfMayRunProtected(ctx.script.text, scan);
    if (option === '-C') {
      dir =
        dir === undefined || isDynamic(value)
          ? undefined
          : path.resolve(dir, value);
    } else if (option === '--git-dir' || option === '--work-tree') {
      dir = undefined;
    } else if (option === '-c' || option === '--config-env') {
      // An alias or a command-valued setting can run other programs.
      scan.hiddenCode = true;
      if (PROTECTED_OPERATION.test(value.slice(value.indexOf('=') + 1))) {
        scan.unverifiable = true;
      }
    }
  }

  const subcommand = args[i];
  if (subcommand === undefined) return;
  if (isDynamic(subcommand)) {
    scan.unverifiable = true;
    return;
  }
  const rest = args.slice(i + 1);
  if (subcommand === 'config') {
    // It can define an alias or a command-valued setting.
    scan.hiddenCode = true;
  } else if (subcommand === 'reset') {
    const parsed = parseOptions(rest);
    const hard = hasLong(parsed, 'hard');
    report(scan, hard, parsed.dynamicOption, 'git reset --hard');
  } else if (subcommand === 'checkout') {
    const parsed = parseOptions(
      rest,
      'bB',
      words('orphan conflict pathspec-from-file'),
    );
    // A ref name cannot start with a dot, so these are pathspecs even
    // without `--`.
    const wholeTree = parsed.operands.some((operand) =>
      WHOLE_TREE_PATHSPEC.test(operand),
    );
    const mayBeWholeTree = parsed.dynamicOperands.some((prefix) =>
      /^[./]*$/.test(prefix),
    );
    report(scan, wholeTree, mayBeWholeTree, 'git checkout -- .');
  } else if (subcommand === 'clean') {
    const parsed = parseOptions(rest, 'e', words('exclude'));
    if (parsed.short.has('n') || hasLong(parsed, 'dry-run')) return;
    const force = parsed.short.has('f') || hasLong(parsed, 'force');
    report(scan, force, parsed.dynamicOption, 'git clean -f');
  } else if (subcommand === 'stash') {
    const action = rest[0] ?? '';
    report(scan, action === 'drop', isDynamic(action), 'git stash drop');
  } else if (subcommand === 'commit') {
    const parsed = parseOptions(
      rest,
      'mFcCt',
      words(
        'message file reuse-message reedit-message template author date fixup squash cleanup trailer pathspec-from-file',
      ),
    );
    if (hasLong(parsed, 'amend', 2)) scan.amendTargets.push(dir);
    else if (parsed.dynamicOption) scan.unverifiable = true;
  } else if (
    subcommand === 'rebase' ||
    subcommand === 'submodule' ||
    subcommand === 'bisect'
  ) {
    // `rebase --exec`, `submodule foreach` and `bisect run` run commands,
    // in directories of their own.
    const text = rest.join(' ');
    if (mayRunProtected(text)) {
      runScript(text, { ...ctx, cwd: undefined }, scan, rest);
    }
  }
}

/** A protected operation ran, or a run-time word could make it run. */
function report(
  scan: Scan,
  ran: boolean,
  dynamic: boolean,
  label: string,
): void {
  if (ran) scan.found ??= label;
  else if (dynamic) scan.unverifiable = true;
}

interface ParsedOptions {
  short: Set<string>;
  long: string[];
  operands: string[];
  /** A word known only at run time may add options. */
  dynamicOption: boolean;
  /** Literal prefixes of operands known only at run time. */
  dynamicOperands: string[];
}

/** Git-style options; listed value options consume their value. */
function parseOptions(
  args: string[],
  shortWithValue = '',
  longWithValue: ReadonlySet<string> = new Set(),
): ParsedOptions {
  const parsed: ParsedOptions = {
    short: new Set(),
    long: [],
    operands: [],
    dynamicOption: false,
    dynamicOperands: [],
  };
  const unknownWords = () => {
    parsed.dynamicOption = true;
    parsed.dynamicOperands.push('');
  };
  // An option value the shell may split can also add options and operands.
  const consume = (value: string | undefined) => {
    if (value?.includes(SPLIT)) unknownWords();
  };
  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const literal = literalOf(arg);
    const dynamic = literal !== arg;
    if (!operandsOnly && arg === '--') {
      operandsOnly = true;
    } else if (
      operandsOnly ||
      arg === '-' ||
      (literal !== '' && !literal.startsWith('-'))
    ) {
      // After `--`, even a split word only adds operands.
      if (dynamic) parsed.dynamicOperands.push(literal);
      else parsed.operands.push(arg);
    } else if (literal === '') {
      unknownWords();
    } else if (literal.startsWith('--')) {
      const equals = literal.indexOf('=');
      if (dynamic && equals < 0) {
        parsed.dynamicOption = true;
        continue;
      }
      const name = literal.slice(2, equals < 0 ? undefined : equals);
      parsed.long.push(name);
      // Git also accepts a prefix of a value option (`--mes` for
      // `--message`); an ambiguous prefix makes git refuse to run.
      if (
        equals < 0 &&
        name !== '' &&
        [...longWithValue].some((option) => option.startsWith(name))
      ) {
        consume(args[++i]);
      }
    } else {
      let j = 1;
      while (j < literal.length && !shortWithValue.includes(literal[j]!)) {
        parsed.short.add(literal[j++]!);
      }
      if (j < literal.length) {
        parsed.short.add(literal[j]!);
        if (j === arg.length - 1) consume(args[++i]);
      } else if (dynamic) {
        // The bundle continues at run time.
        parsed.dynamicOption = true;
      }
    }
  }
  return parsed;
}

/** Git accepts any unambiguous prefix of a long option. */
function hasLong(parsed: ParsedOptions, option: string, minLength = 1) {
  return parsed.long.some(
    (name) => name.length >= minLength && option.startsWith(name),
  );
}

function checkIac(program: string, args: string[], scan: Scan): void {
  // The subcommand is the first operand, or the second when the first may
  // have been the value of a preceding option.
  let mayBeValue = false;
  for (const arg of args) {
    if (arg === '--') return;
    if (arg.startsWith('-')) {
      mayBeValue = !arg.includes('=');
      continue;
    }
    if (isDynamic(arg)) {
      scan.unverifiable = true;
      return;
    }
    if (arg === 'destroy') {
      scan.found ??= `${program} destroy`;
      return;
    }
    if (!mayBeValue) return;
    mayBeValue = false;
  }
}

function checkShell(args: string[], ctx: CommandContext, scan: Scan): void {
  let runsCommand = false;
  let readsStdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (isDynamic(arg)) {
      // A run-time word may be an option, the script, or a script's path.
      scan.hiddenCode = true;
      return;
    }
    if (arg === '--' || arg === '-') {
      i++;
      break;
    }
    if (!/^[-+]./.test(arg)) break;
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]*c/.test(arg)) runsCommand = true;
    if (/^-[A-Za-z]*s/.test(arg)) readsStdin = true;
  }
  if (runsCommand) {
    if (args[i] !== undefined) runScript(args[i]!, ctx, scan);
    return;
  }
  // Otherwise a script file, unless the program comes from stdin.
  if (i < args.length && !readsStdin) {
    scan.hiddenCode = true;
    return;
  }
  readStdin(ctx, scan);
}

/** Weighs each program a shell reads on stdin. */
function readStdin(ctx: CommandContext, scan: Scan): void {
  const parent = ctx.node.parent;
  const stage = parent?.type === 'redirected_statement' ? parent : ctx.node;
  const redirects = [...ctx.node.namedChildren];
  // The parser hangs a trailing redirect on a whole `a && b` list; bash
  // applies it to the last command.
  for (
    let node = ctx.node;
    node.parent?.type === 'redirected_statement' ||
    (node.parent?.type === 'list' &&
      node.parent.lastNamedChild?.startIndex === node.startIndex);
    node = node.parent
  ) {
    if (node.parent.type === 'redirected_statement') {
      redirects.push(...node.parent.namedChildren);
    }
  }
  for (const redirect of redirects) {
    if (
      redirect.type === 'file_redirect' &&
      redirect.children.some((child) => child.type === '<')
    ) {
      // A program file.
      scan.hiddenCode = true;
      continue;
    }
    const body =
      redirect.type === 'herestring_redirect'
        ? redirect.firstNamedChild
        : redirect.type === 'heredoc_redirect'
          ? redirect.namedChildren.find(
              (child) => child.type === 'heredoc_body',
            )
          : undefined;
    if (!body) continue;
    runScript(
      body.type !== 'heredoc_body'
        ? wordOf(body)
        : body.namedChildren.every((child) => child.type === 'heredoc_content')
          ? body.text
          : DYNAMIC + body.text,
      ctx,
      scan,
      body,
    );
  }
  // A program piped in from an earlier stage only exists at run time.
  const pipeline = stage.parent;
  if (
    pipeline?.type === 'pipeline' &&
    pipeline.namedChildren.some((child) => child.startIndex < stage.startIndex)
  ) {
    scan.hiddenCode = true;
  }
}

/**
 * Runs `text` as a nested script, weighed on its own; `from` are the
 * argument words it came from, or the heredoc or here-string node.
 */
function runScript(
  text: string,
  ctx: CommandContext,
  scan: Scan,
  from: string[] | SyntaxNode = [text],
): void {
  if (isDynamic(text)) {
    // Its program is only known at run time.
    scan.hiddenCode = true;
    return;
  }
  const sources = Array.isArray(from)
    ? argumentNodes(ctx.node).filter((node) => from.includes(wordOf(node)))
    : [from];
  for (const node of sources) {
    ctx.script.checked.push([node.startIndex, node.endIndex]);
  }
  scan.scripts.push({
    text,
    cwd: ctx.cwd,
    depth: ctx.script.depth + 1,
    checked: [],
  });
}

function mayRunProtected(text: string): boolean {
  const plain = text.replace(/["']/g, '');
  // `g\it` is `git`; printf's `\ngit` starts a new word, and printf,
  // `echo -e` and `$'…'` read `\x67` as `g`.
  const decoded = plain.replace(
    /\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|0?([0-7]{1,3}))/g,
    (_, hex?: string, unicode?: string, octal?: string) =>
      String.fromCharCode(
        octal === undefined
          ? parseInt(hex ?? unicode!, 16)
          : parseInt(octal, 8),
      ),
  );
  return [plain.replace(/\\/g, ''), decoded.replace(/\\./g, ' ')].some(
    (variant) =>
      PROTECTED_PROGRAM.test(variant) && MENTIONED_OPERATION.test(variant),
  );
}

function flagIfMayRunProtected(text: string, scan: Scan): void {
  if (mayRunProtected(text)) scan.unverifiable = true;
}
