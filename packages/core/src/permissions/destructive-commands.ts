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
import {
  evaluateCommandSafety,
  parseShellCommand,
} from '../utils/shellAstParser.js';
import {
  hasShellBraceExpansion,
  hasShellPatternExpansion,
} from '../utils/shell-safety-rules.js';

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
/** A brace/pathname pattern, kept distinct from variable word splitting. */
const PATTERN = `${SPLIT}\u0002`;

const words = (list: string) => new Set(list.split(' '));

const IAC_TOOLS = words('terraform pulumi cdk');
const SHELLS = words('sh bash zsh dash ksh fish ash mksh csh tcsh');
/** Run code in another language, which the guard cannot read. */
const INTERPRETER =
  /^(?:python[\d.]*|node|perl|ruby|php|[gmn]?awk|lua(?:jit)?|deno|bun|osascript|tclsh|rscript)$/;
const SHELL_OPTIONS_WITH_VALUE = words('-o +o -O +O --rcfile --init-file');
/** Shell startup files, which the shell runs before its command. */
const STARTUP_FILE_OPTIONS = words('--rcfile --init-file');
const STARTUP_FILE_VARIABLES = words('BASH_ENV ENV');
/** Constructs whose commands all read the stdin given to the construct. */
const STDIN_SHARING = words(
  'subshell compound_statement do_group while_statement for_statement c_style_for_statement if_statement elif_clause else_clause case_statement case_item',
);
/** Run the rest of their arguments as one script. */
const SCRIPT_RUNNERS = words('eval cmd powershell pwsh');
const DIRECTORY_CHANGES = words('cd pushd popd');
/** Only read their arguments as data: text to print, patterns, files. */
const DATA_ONLY = words(
  'echo printf grep egrep fgrep zgrep rg ag ack cat less more head tail wc sort uniq cut nl jq diff ls stat file test [',
);
const RG_VALUE_OPTIONS = words(
  '--after-context --before-context --context --encoding --regexp --file --glob --iglob --ignore-file --threads --max-count --max-columns --replace --type --type-not --type-add --type-clear --pre-glob --color --colors --context-separator --dfa-size-limit --engine --field-context-separator --field-match-separator --hyperlink-format --max-depth --max-filesize --path-separator --regex-size-limit --sort --sortr --generate',
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
/** Environment variables whose value git runs or reads settings from. */
const GIT_COMMAND_VARIABLE =
  /^(?:GIT_(?:EDITOR|SEQUENCE_EDITOR|PAGER|EXTERNAL_DIFF|SSH|SSH_COMMAND|ASKPASS|PROXY_COMMAND|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)|EDITOR|VISUAL|PAGER)$/;
/** Git settings whose value is a command, or that bring in other settings. */
const GIT_COMMAND_SETTING =
  /^(?:alias|pager|filter|credential|include|includeif|diff|merge|difftool|mergetool|gpg|ssh)\.|^(?:core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass|gitproxy|alternaterefscommand)|sequence\.editor|uploadpack\.packobjectshook)$|^remote\..*\.(?:uploadpack|receivepack|vcs)$/i;
/** Git commands that move HEAD, so a later amend rewrites a commit nobody checked. */
const GIT_HEAD_MOVES = words(
  'commit merge rebase reset cherry-pick revert pull am checkout switch update-ref',
);
/** Git's own commands; any other word may be an alias. */
const GIT_SUBCOMMANDS = words(
  'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential daemon describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook http-backend index-pack init init-db instaweb interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree',
);
/** A path into a repository's `.git`, whose config and hooks git runs. */
const GIT_METADATA_PATH = /(?:^|\/)\.git(?:\/|$)/;
/** Same bound as the shell-wrapper unwrapping in `shell-semantics.ts`. */
const MAX_SCRIPT_DEPTH = 4;

const PROTECTED_OPERATIONS = words('reset checkout clean stash commit destroy');
const PROTECTED_OPERATION = new RegExp(
  `\\b(?:${[...PROTECTED_OPERATIONS].join('|')})\\b`,
);
// Whole words only: `git-clean.sh`, `.git/` and `reset.ts` name files, but
// `git.exe` and `GIT` are the program, as `programName` reads them.
const PROTECTED_PROGRAM =
  /(?<![\w.-])(?:git|terraform|pulumi|cdk)(?:\.exe)?(?![\w./-])/i;
/** Text that may spell a protected operation; a commit only when amended. */
const MENTIONED_OPERATION =
  /(?<![\w./-])(?:reset|checkout|clean|stash|destroy|amend)(?![\w./-])|--am/;

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
  /** Literal stdout data, excluded only when no output can feed code. */
  printed: Array<[number, number]>;
  /** An earlier opaque command could have changed the shell's descriptors. */
  opaqueCommandSeen: boolean;
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
  /** An argument pattern of a run-time program may supply an operation. */
  patternArguments: boolean;
  /** A protected program named as an argument of an unverified wrapper. */
  unverifiedProgram: boolean;
  outputMayFeedCode: boolean;
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
    scripts: [
      {
        text: joinLines(command),
        cwd,
        depth: 0,
        checked: [],
        printed: [],
        opaqueCommandSeen: false,
      },
    ],
    amendTargets: [],
    movesRepository: false,
    unverifiable: false,
    patternArguments: false,
    unverifiedProgram: false,
    outputMayFeedCode: false,
    hiddenCode: false,
  };
  for (let i = 0; i < scan.scripts.length && !scan.found; i++) {
    await scanScript(scan.scripts[i]!, scan);
  }
  // Hidden code can come from anywhere in the command: text it prints,
  // writes to a file or keeps in a variable.
  if (scan.hiddenCode) {
    for (const { text, checked, printed } of scan.scripts) {
      let rest = text;
      for (const [start, end] of checked) {
        rest = rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end);
      }
      if (mayRunProtected(rest)) scan.unverifiable = true;
      if (scan.patternArguments) {
        if (!scan.outputMayFeedCode) {
          for (const [start, end] of printed) {
            rest =
              rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end);
          }
        }
        if (mayRunProtected(rest, true)) scan.unverifiable = true;
      }
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
  if (scan.unverifiable || (scan.patternArguments && scan.unverifiedProgram)) {
    return { blocked: true, reason: UNVERIFIABLE_REASON };
  }
  return null;
}

/** The shell joins a backslash-newline to the next line. */
function joinLines(text: string): string {
  return text.replace(/\\\r?\n/g, '');
}

async function scanScript(script: Script, scan: Scan): Promise<void> {
  if (script.depth > MAX_SCRIPT_DEPTH) {
    // Too deep to follow: what it runs is unknown, whoever names it.
    scan.hiddenCode = true;
    flagIfMentionsOperation(script.text, scan);
    return;
  }
  let tree: Parser.Tree;
  try {
    tree = await parseShellCommand(script.text);
  } catch {
    // The parser read nothing at all (it throws on `case`, for one).
    flagIfMentionsOperation(script.text, scan);
    return;
  }
  try {
    if (tree.rootNode.hasError) {
      scan.outputMayFeedCode = true;
      flagIfMayRunProtected(script.text, scan);
    }
    const stack: SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      // Keep data evidence across transfers, including persistent `exec`
      // redirects and functions whose callers may capture their output.
      if (
        node.type.endsWith('_redirect') ||
        node.type.endsWith('_substitution') ||
        node.type === 'pipeline' ||
        node.type === 'function_definition' ||
        node.type === 'do_group'
      ) {
        scan.outputMayFeedCode = true;
      }
      if (node.type === 'command') {
        visitCommand(node, script, scan);
      } else if (node.type === 'comment') {
        script.checked.push([node.startIndex, node.endIndex]);
      } else if (node.type === 'variable_assignment') {
        visitAssignment(node, scan);
      } else if (
        node.type === 'file_redirect' &&
        node.children.some((child) =>
          /^(?:>|>>|>\||>&|&>|&>>|<>)$/.test(child.type),
        ) &&
        GIT_METADATA_PATH.test(
          literalOf(wordOf(node.childForFieldName('destination') ?? node)),
        )
      ) {
        // Writing a repository's config or hooks changes what git runs.
        scan.hiddenCode = true;
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
  const argv = [wordOf(name), ...argumentNodes(node).map(wordOf)];
  const [program, ...args] = argv;
  const format = args[0] === '--' ? (args[1] ?? '') : (args[0] ?? '');
  if (
    !script.opaqueCommandSeen &&
    argv.every((word) => !isDynamic(word)) &&
    !node.namedChildren.some((child) => child.type === 'variable_assignment') &&
    (program === 'echo' ||
      (program === 'printf' &&
        !format.startsWith('-') &&
        // Other printf conversions can assign variables, e.g. `%n`.
        !/%(?![%s])/.test(format)))
  ) {
    script.printed.push([node.startIndex, node.endIndex]);
  }
  runArgv(argv, { node, script, cwd: script.cwd }, scan);
}

/** `NAME=value`, alone or in front of a command. */
function visitAssignment(node: SyntaxNode, scan: Scan): void {
  const name = node.childForFieldName('name')?.text ?? '';
  const valueNode = node.childForFieldName('value');
  const value = valueNode ? wordOf(valueNode) : '';
  if (GIT_REPOSITORY_VARIABLES.has(name)) {
    scan.movesRepository = true;
  } else if (STARTUP_FILE_VARIABLES.has(name)) {
    // A shell started later runs this file first.
    scan.hiddenCode = true;
    scan.outputMayFeedCode = true;
  } else if (GIT_COMMAND_VARIABLE.test(name)) {
    // Git runs the value, or reads settings that can run anything.
    scan.hiddenCode = true;
    scan.movesRepository = true;
    if (isDynamic(value) || PROTECTED_OPERATION.test(value)) {
      scan.unverifiable = true;
    }
  }
}

/**
 * Leaves the words naming a checked operation (program, global options,
 * subcommand) out of the evidence for hidden code. Its other arguments stay:
 * it may print them, as a commit message or a log format.
 */
function markChecked(ctx: CommandContext, named: string[]): void {
  if (named.some((word) => isDynamic(word))) return;
  const name = ctx.node.childForFieldName('name');
  if (!name) return;
  const nodes = [name, ...argumentNodes(ctx.node)];
  const texts = nodes.map(wordOf);
  for (let i = 0; i + named.length <= texts.length; i++) {
    if (named.every((word, j) => texts[i + j] === word)) {
      ctx.script.checked.push([
        nodes[i]!.startIndex,
        nodes[i + named.length - 1]!.endIndex,
      ]);
      return;
    }
  }
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
  switch (node.type) {
    case 'command_name':
      return node.firstNamedChild ? wordOf(node.firstNamedChild) : DYNAMIC;
    case 'word':
      if (node.text.startsWith('~')) return DYNAMIC;
      // Pathname expansion (`*`, `?`, `[`) turns one word into any number.
      if (hasShellPatternExpansion(node.text.replace(/\\./g, ''))) {
        return PATTERN;
      }
      return node.text.replace(/\\(\n|.)/g, (_, c: string) =>
        c === '\n' ? '' : c,
      );
    case 'number':
      return node.text;
    case 'brace_expression':
      return PATTERN;
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
      // The parser splits prefixed brace sequences into separate words.
      const unquoted = node.namedChildren
        .map((part) =>
          part.type === 'word' ? part.text.replace(/\\./g, '') : '\0',
        )
        .join('');
      if (hasShellBraceExpansion(unquoted)) return PATTERN;
      const parts = node.namedChildren.map(wordOf);
      if (parts.some((part) => part.includes(PATTERN))) return PATTERN;
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
    ctx.script.opaqueCommandSeen = true;
    scan.patternArguments ||= args.some((arg) => arg.includes(PATTERN));
    if (
      args.some(
        (arg) =>
          PROTECTED_OPERATIONS.has(arg) ||
          (head.includes(PATTERN) && arg.includes(SPLIT)),
      )
    ) {
      scan.unverifiable = true;
    }
    return;
  }
  const program = programName(head);
  if (
    SCRIPT_RUNNERS.has(program) ||
    ['.', 'source', 'trap'].includes(program)
  ) {
    scan.outputMayFeedCode = true;
  }
  if (program === 'git') return checkGit(head, args, ctx, scan);
  if (IAC_TOOLS.has(program)) return checkIac(head, program, args, ctx, scan);
  if (program === 'rg') {
    let preprocessor = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') break;
      if (arg.includes(SPLIT)) scan.hiddenCode = true;
      else if (arg === '--pre') {
        const value = args[++i];
        if (value?.includes(SPLIT)) scan.hiddenCode = true;
        preprocessor = value !== '';
      } else if (arg.startsWith('--pre=')) preprocessor = arg.length > 6;
      else if (arg === '--no-pre') preprocessor = false;
      else if (/^(?:--hostname-bin(?:=|$)|--search-zip$)/.test(arg)) {
        scan.hiddenCode = true;
      } else if (RG_VALUE_OPTIONS.has(arg)) {
        if (args[++i]?.includes(SPLIT)) scan.hiddenCode = true;
      } else if (/^-[^-]/.test(arg)) {
        for (let j = 1; j < arg.length; j++) {
          if ('ABCEdefgjmMrtT'.includes(arg[j]!)) {
            if (j === arg.length - 1 && args[++i]?.includes(SPLIT)) {
              scan.hiddenCode = true;
            }
            break;
          }
          if (arg[j] === 'z') scan.hiddenCode = true;
        }
      }
    }
    scan.hiddenCode ||= preprocessor;
  }
  if (
    args.some((arg) => GIT_METADATA_PATH.test(literalOf(arg))) &&
    (args.some(isDynamic) ||
      evaluateCommandSafety(ctx.node, args) !== 'read-only')
  ) {
    // A repository's `.git` replaced or rewritten: what a later git command
    // reaches, and what its config and hooks run, are unknown.
    scan.hiddenCode = true;
    scan.movesRepository = true;
  }
  if (SHELLS.has(program)) return checkShell(args, ctx, scan);
  if (SCRIPT_RUNNERS.has(program)) {
    // `pwsh -File fix.ps1` runs a script file.
    if (args.some((arg) => /^[-/]f(?:ile)?$/i.test(arg))) {
      scan.hiddenCode = true;
      return;
    }
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
  // An unknown program may still wrap a command the guard interprets, or
  // run code it is handed (`trap 'cmd' EXIT`, `lua -e …`).
  ctx.script.opaqueCommandSeen = true;
  for (let i = 1; i < argv.length; i++) {
    if (isInterpreted(argv[i]!)) {
      const argumentProgram = programName(argv[i]!);
      scan.unverifiedProgram ||=
        argumentProgram === 'git' || IAC_TOOLS.has(argumentProgram);
      runArgv(argv.slice(i), { ...ctx, cwd: undefined }, scan);
    }
  }
  for (const arg of args) flagIfMayRunProtected(arg, scan);
}

/** Checks the command a wrapper runs, possibly from another directory. */
function runWrapped(
  program: string,
  wrapper: Wrapper,
  args: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
  // Wrappers can change startup state, e.g. `env BASH_ENV=... bash -c ...`.
  ctx.script.opaqueCommandSeen = true;
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

function checkGit(
  head: string,
  args: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
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
    // A split value can push any words in front of the subcommand.
    if (value.includes(SPLIT)) scan.unverifiable = true;
    if (option === '-C') {
      dir =
        dir === undefined || isDynamic(value)
          ? undefined
          : path.resolve(dir, value);
    } else if (option === '--git-dir' || option === '--work-tree') {
      dir = undefined;
    } else if (option === '-c' || option === '--config-env') {
      const key = value.slice(0, Math.max(value.indexOf('='), 0)) || value;
      const setting = value.slice(value.indexOf('=') + 1);
      checkGitSetting(key, option === '-c' ? setting : '', scan);
    }
  }

  const subcommand = args[i];
  markChecked(ctx, [head, ...args.slice(0, i + 1)]);
  if (subcommand === undefined) return;
  if (isDynamic(subcommand)) {
    scan.unverifiable = true;
    return;
  }
  const rest = args.slice(i + 1);
  // A commit created or HEAD moved earlier on the line is not the one a
  // later amend's check reads.
  if (GIT_HEAD_MOVES.has(subcommand) && subcommand !== 'commit') {
    scan.movesRepository = true;
  }
  if (subcommand === 'config') {
    // Setting an alias or a command-valued setting.
    const operands = rest.filter((word) => !literalOf(word).startsWith('-'));
    if (operands.length >= 2) checkGitSetting(operands[0]!, operands[1]!, scan);
  } else if (!GIT_SUBCOMMANDS.has(subcommand)) {
    // Possibly an alias, which runs whatever it was set to.
    scan.hiddenCode = true;
  } else if (subcommand === 'reset') {
    const parsed = parseOptions(rest);
    const hard = hasLong(parsed, 'hard');
    report(scan, hard, parsed.dynamicOption, 'git reset --hard');
  } else if (subcommand === 'checkout') {
    checkCheckout(rest, scan);
  } else if (subcommand === 'clean') {
    const parsed = parseOptions(rest, 'e', words('exclude'));
    if (parsed.short.has('n') || hasLong(parsed, 'dry-run')) return;
    const force = parsed.short.has('f') || hasLong(parsed, 'force');
    report(scan, force, parsed.dynamicOption, 'git clean -f');
  } else if (subcommand === 'stash') {
    // Options may come before the action (`git stash -q drop`).
    const action = rest.find((word) => !literalOf(word).startsWith('-')) ?? '';
    const dynamic = rest.some((word) => isDynamic(word));
    report(scan, action === 'drop', dynamic, 'git stash drop');
  } else if (subcommand === 'commit') {
    const parsed = parseOptions(
      rest,
      'mFcCt',
      words(
        'message file reuse-message reedit-message template author date fixup squash cleanup trailer pathspec-from-file',
      ),
    );
    if (hasLong(parsed, 'amend', 2)) scan.amendTargets.push(dir);
    else {
      scan.movesRepository = true;
      if (parsed.dynamicOption) scan.unverifiable = true;
    }
  } else if (subcommand === 'rebase') {
    runGitCommandOptions(rest, words('-x --exec'), ctx, scan);
  } else if (subcommand === 'difftool') {
    runGitCommandOptions(rest, words('-x --extcmd'), ctx, scan);
  } else if (subcommand === 'submodule') {
    // `submodule foreach <command>` runs the command in each submodule.
    let at = rest.indexOf('foreach') + 1;
    if (at === 0) return;
    while (at < rest.length && /^-/.test(literalOf(rest[at]!))) at++;
    const command = rest.slice(at);
    if (command.length > 0) {
      runGitCommand(command.join(' '), command, ctx, scan);
    }
  } else if (subcommand === 'bisect') {
    // `bisect run <cmd> [args]` runs the command at each step.
    const at = rest.indexOf('run');
    if (at >= 0 && at + 1 < rest.length) {
      runArgv(rest.slice(at + 1), { ...ctx, cwd: undefined }, scan);
    }
  }
}

/** `git -c key=value`, `git config key value`, `--config-env`. */
function checkGitSetting(key: string, value: string, scan: Scan): void {
  if (!GIT_COMMAND_SETTING.test(literalOf(key)) && !isDynamic(key)) return;
  // An alias or a command-valued setting can run other programs.
  scan.hiddenCode = true;
  if (isDynamic(value) || PROTECTED_OPERATION.test(value)) {
    scan.unverifiable = true;
  }
}

/** `rebase -x <cmd>`, `--exec=<cmd>`, `difftool --extcmd <cmd>`. */
function runGitCommandOptions(
  rest: string[],
  options: ReadonlySet<string>,
  ctx: CommandContext,
  scan: Scan,
): void {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    const literal = literalOf(word);
    const equals = literal.indexOf('=');
    const name = equals < 0 ? literal : literal.slice(0, equals);
    if (options.has(name)) {
      if (equals >= 0) {
        runGitCommand(word.slice(equals + 1), [word], ctx, scan);
      } else if (i + 1 < rest.length) {
        runGitCommand(rest[i + 1]!, [word, rest[i + 1]!], ctx, scan);
        i++;
      }
    } else if (
      [...options].some(
        (option) => option.length === 2 && name.startsWith(option),
      ) &&
      name.length > 2 &&
      !name.startsWith('--')
    ) {
      // `-xCMD`.
      runGitCommand(word.slice(2), [word], ctx, scan);
    } else if (isDynamic(word) && !literal.startsWith('-') && literal === '') {
      // A run-time word may be such an option.
      scan.unverifiable = true;
    }
  }
}

/** A command git runs; one it cannot read is not given the benefit. */
function runGitCommand(
  command: string,
  from: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
  if (isDynamic(command)) {
    scan.unverifiable = true;
    return;
  }
  runScript(command, { ...ctx, cwd: undefined }, scan, from);
}

/** `git checkout` discards work for whole-tree pathspecs and with `-f`. */
function checkCheckout(rest: string[], scan: Scan): void {
  const parsed = parseOptions(
    rest,
    'bB',
    words('orphan conflict pathspec-from-file'),
  );
  if (parsed.short.has('f') || hasLong(parsed, 'force')) {
    // Throws away local changes, whatever it checks out.
    scan.found ??= 'git checkout -f';
    return;
  }
  const wholeTree = parsed.operands.some(isWholeTreePathspec);
  // A run-time pathspec, a pattern, a magic pathspec or a pathspec file may
  // name the whole tree.
  const mayBeWholeTree =
    parsed.dynamicOption ||
    parsed.dynamicOperands.length > 0 ||
    hasLong(parsed, 'pathspec-from-file', 10) ||
    parsed.operands.some(
      (operand) => operand.startsWith(':') || /[*?[]/.test(operand),
    );
  report(scan, wholeTree, mayBeWholeTree, 'git checkout -- .');
}

/** A pathspec that resolves to the current directory or one of its parents. */
function isWholeTreePathspec(pathspec: string): boolean {
  const normalized = path.posix.normalize(pathspec);
  return (
    normalized === '.' ||
    normalized === './' ||
    normalized === '..' ||
    normalized.startsWith('../')
  );
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

function checkIac(
  head: string,
  program: string,
  args: string[],
  ctx: CommandContext,
  scan: Scan,
): void {
  // The subcommand is the first operand, or the second when the first may
  // have been the value of a preceding option.
  let mayBeValue = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
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
    if (!mayBeValue) {
      markChecked(ctx, [head, ...args.slice(0, i + 1)]);
      return;
    }
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
    if (/^(?:--(?:login|interactive)|-[A-Za-z]*[il][A-Za-z]*)$/.test(arg)) {
      scan.outputMayFeedCode = true;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) {
      // A startup file is a script the shell runs first.
      if (STARTUP_FILE_OPTIONS.has(arg)) {
        scan.hiddenCode = true;
        scan.outputMayFeedCode = true;
      }
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
  const redirects = [...ctx.node.namedChildren];
  // Stdin comes from the redirects and pipelines around the shell, also
  // those attached to a group, subshell or loop it sits in. The parser hangs
  // a trailing redirect on a whole `a && b` list; bash applies it to the
  // last command.
  for (let node = ctx.node; node.parent; node = node.parent) {
    const parent: SyntaxNode = node.parent;
    if (parent.type === 'redirected_statement') {
      redirects.push(...parent.namedChildren.filter((child) => child !== node));
    } else if (parent.type === 'pipeline') {
      // A program piped in from an earlier stage only exists at run time.
      if (
        parent.namedChildren.some((child) => child.startIndex < node.startIndex)
      ) {
        scan.hiddenCode = true;
      }
    } else if (
      !(
        STDIN_SHARING.has(parent.type) ||
        (parent.type === 'list' &&
          parent.lastNamedChild?.startIndex === node.startIndex)
      )
    ) {
      break;
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
    printed: [],
    opaqueCommandSeen: ctx.script.opaqueCommandSeen,
  });
}

function mayRunProtected(text: string, patternArguments = false): boolean {
  const plain = joinLines(text).replace(/["']/g, '');
  // `g\it` is `git`; printf's `\ngit` starts a new word, and printf,
  // `echo -e` and `$'…'` read `\x67`, `g`, `\U00000067` and `\147` as
  // `g`. A shell later reading `\g` drops the backslash too.
  const decoded = plain.replace(
    /\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|0?([0-7]{1,3}))/g,
    (_, hex?: string, unicode?: string, wide?: string, octal?: string) => {
      const code =
        octal === undefined
          ? parseInt(hex ?? unicode ?? wide!, 16)
          : parseInt(octal, 8);
      return code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    },
  );
  return [
    plain.replace(/\\/g, ''),
    decoded.replace(/\\[ntrvfab]/g, ' ').replace(/\\/g, ''),
    decoded.replace(/\\./g, ' '),
  ].some(
    (variant) =>
      PROTECTED_PROGRAM.test(variant) &&
      (patternArguments || MENTIONED_OPERATION.test(variant)),
  );
}

function flagIfMayRunProtected(text: string, scan: Scan): void {
  if (mayRunProtected(text)) scan.unverifiable = true;
}

/** For text the guard cannot read at all: an operation's name is enough. */
function flagIfMentionsOperation(text: string, scan: Scan): void {
  if (mayRunProtected(text) || MENTIONED_OPERATION.test(joinLines(text))) {
    scan.unverifiable = true;
  }
}
