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
const SHELL_OPTIONS_WITH_VALUE = words('-o +o -O +O --rcfile --init-file');
/** Run the rest of their arguments as one script. */
const SCRIPT_RUNNERS = words('eval cmd powershell pwsh');
const DIRECTORY_CHANGES = words('cd pushd popd');
/** Only print their arguments. */
const PRINTERS = words('echo printf');
const GIT_GLOBAL_OPTIONS_WITH_VALUE = words(
  '-C -c --git-dir --work-tree --namespace --super-prefix --config-env --attr-source',
);
const GIT_REPOSITORY_VARIABLES = words('GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR');
const WRITE_REDIRECTS = words('> >> >| &> &>>');
/** Same bound as the shell-wrapper unwrapping in `shell-semantics.ts`. */
const MAX_SCRIPT_DEPTH = 4;

const PROTECTED_OPERATIONS = words('reset checkout clean stash commit destroy');
const PROTECTED_PROGRAM = /\b(?:git|terraform|pulumi|cdk)\b/;
const PROTECTED_OPERATION = new RegExp(
  `\\b(?:${[...PROTECTED_OPERATIONS].join('|')})\\b`,
);

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
}

interface Scan {
  scripts: Script[];
  found?: string;
  /** Directory of each `git commit --amend`; undefined when unknown. */
  amendTargets: Array<string | undefined>;
  /** A cd or repository variable may point a later git command elsewhere. */
  movesRepository: boolean;
  unverifiable: boolean;
  /** Files the command writes, with the statements that write them. */
  writtenFiles: Map<string, string>;
  /** Script files the command runs. */
  scriptRuns: string[];
}

interface CommandContext {
  node: SyntaxNode;
  /** Text of the script the command belongs to. */
  text: string;
  cwd: string | undefined;
  depth: number;
}

/**
 * Check whether a shell command runs a protected destructive operation.
 * Printed text, comments and other data never count; an operation the guard
 * cannot rule out (parse failure, run-time program or arguments) is blocked
 * too when the command mentions a protected program and operation.
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
    scripts: [{ text: command, cwd, depth: 0 }],
    amendTargets: [],
    movesRepository: false,
    unverifiable: false,
    writtenFiles: new Map(),
    scriptRuns: [],
  };
  for (
    let script = scan.scripts.shift();
    script && !scan.found;
    script = scan.scripts.shift()
  ) {
    await scanScript(script, scan);
  }
  // A script the same command writes is a program the guard cannot see run.
  for (const file of scan.scriptRuns) {
    flagIfMayRunProtected(scan.writtenFiles.get(file) ?? '', scan);
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
      } else if (
        node.type === 'file_redirect' &&
        node.children.some((child) => WRITE_REDIRECTS.has(child.type))
      ) {
        const destination = node.childForFieldName('destination');
        recordWrite(
          scan,
          destination ? scriptPath(wordOf(destination)) : undefined,
          node.parent?.text ?? '',
        );
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
  const argv = [wordOf(name)];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === 'argument') {
      argv.push(wordOf(node.child(i)!));
    }
  }
  runArgv(
    argv,
    { node, text: script.text, cwd: script.cwd, depth: script.depth },
    scan,
  );
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

/** A literal script path, normalized so `./x.sh` and `x.sh` match. */
function scriptPath(word: string | undefined): string | undefined {
  return word && !isDynamic(word) ? path.posix.normalize(word) : undefined;
}

function recordWrite(scan: Scan, file: string | undefined, writer: string) {
  if (!file) return;
  scan.writtenFiles.set(
    file,
    `${scan.writtenFiles.get(file) ?? ''}\n${writer}`,
  );
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
    SCRIPT_RUNNERS.has(name) ||
    DIRECTORY_CHANGES.has(name) ||
    name === 'tee' ||
    name === '.' ||
    name === 'source'
  );
}

function runArgv(argv: string[], ctx: CommandContext, scan: Scan): void {
  const [head = '', ...args] = argv;
  if (isDynamic(head)) {
    // e.g. `$GIT reset --hard`: the program is only known at run time.
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
    return runScript(args.join(' '), ctx, scan);
  }
  if (DIRECTORY_CHANGES.has(program)) {
    scan.movesRepository = true;
    return;
  }
  if (PRINTERS.has(program)) return;
  if (program === 'tee') {
    // What tee writes comes from the pipeline in front of it.
    let writer = ctx.node;
    while (
      writer.parent?.type === 'redirected_statement' ||
      writer.parent?.type === 'pipeline'
    ) {
      writer = writer.parent;
    }
    for (const file of args.filter((arg) => !arg.startsWith('-'))) {
      recordWrite(scan, scriptPath(file), writer.text);
    }
    return;
  }
  if (program === '.' || program === 'source') {
    const file = scriptPath(args[0]);
    if (file) scan.scriptRuns.push(file);
    return;
  }
  const file = head.includes('/') ? scriptPath(head) : undefined;
  if (file) scan.scriptRuns.push(file);
  // sudo, env, xargs, timeout, npx and similar run the rest of their argv,
  // possibly from another directory. `find -exec` and `xargs -I` put a
  // run-time argument where `{}` stands, and xargs appends what it reads.
  for (let i = 1; i < argv.length; i++) {
    if (isDynamic(argv[i]!) || isInterpreted(argv[i]!)) {
      const suffix = argv
        .slice(i)
        .map((word) => (word === '{}' ? DYNAMIC : word));
      if (program === 'xargs') suffix.push(SPLIT);
      runArgv(suffix, { ...ctx, cwd: undefined }, scan);
    }
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
    if (value.includes(SPLIT)) flagIfMayRunProtected(ctx.text, scan);
    if (option === '-C') {
      dir =
        dir === undefined || isDynamic(value)
          ? undefined
          : path.resolve(dir, value);
    } else if (option === '--git-dir' || option === '--work-tree') {
      dir = undefined;
    } else if (
      option === '-c' &&
      PROTECTED_OPERATION.test(value.slice(value.indexOf('=') + 1))
    ) {
      // An alias or command-valued setting may run a protected operation.
      scan.unverifiable = true;
    }
  }

  const subcommand = args[i];
  if (subcommand === undefined) return;
  if (isDynamic(subcommand)) {
    scan.unverifiable = true;
    return;
  }
  const rest = args.slice(i + 1);
  if (subcommand === 'reset') {
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
      runScript(text, { ...ctx, cwd: undefined }, scan);
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
      if (equals < 0 && longWithValue.has(name)) consume(args[++i]);
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
      flagIfMayRunProtected(args.slice(i).join(' '), scan);
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
    const file = scriptPath(args[i]);
    if (file) scan.scriptRuns.push(file);
    return;
  }
  runStdinProgram(ctx, scan);
}

function runStdinProgram(ctx: CommandContext, scan: Scan): void {
  const parent = ctx.node.parent;
  const stage = parent?.type === 'redirected_statement' ? parent : ctx.node;
  const redirects =
    stage === ctx.node
      ? ctx.node.namedChildren
      : [...ctx.node.namedChildren, ...stage.namedChildren];
  for (const redirect of redirects) {
    const body =
      redirect.type === 'herestring_redirect'
        ? redirect.firstNamedChild
        : redirect.type === 'heredoc_redirect'
          ? redirect.namedChildren.find(
              (child) => child.type === 'heredoc_body',
            )
          : undefined;
    if (!body) continue;
    const text =
      body.type !== 'heredoc_body'
        ? wordOf(body)
        : body.namedChildren.every((child) => child.type === 'heredoc_content')
          ? body.text
          : DYNAMIC + body.text;
    runScript(text, ctx, scan);
  }
  // A program piped in from an earlier stage only exists at run time.
  const pipeline = stage.parent;
  if (
    pipeline?.type === 'pipeline' &&
    pipeline.firstNamedChild?.startIndex !== stage.startIndex
  ) {
    flagIfMayRunProtected(pipeline.text, scan);
  }
}

function runScript(text: string, ctx: CommandContext, scan: Scan): void {
  if (isDynamic(text)) {
    flagIfMayRunProtected(text, scan);
  } else {
    scan.scripts.push({ text, cwd: ctx.cwd, depth: ctx.depth + 1 });
  }
}

function mayRunProtected(text: string): boolean {
  const plain = text.replace(/["'\\]/g, '');
  return PROTECTED_PROGRAM.test(plain) && PROTECTED_OPERATION.test(plain);
}

function flagIfMayRunProtected(text: string, scan: Scan): void {
  if (mayRunProtected(text)) scan.unverifiable = true;
}
