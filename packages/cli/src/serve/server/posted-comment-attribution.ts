/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marker-free authorship attribution for the bound PR comment watch
 * (docs/design/2026-11-08-bound-pr-comment-watch.md).
 *
 * A bound session must not receive a comment it posted itself, but GitHub
 * gives the channel one account identity for every local session, so the
 * comment's `user.login` cannot distinguish them. The only per-session,
 * marker-free evidence is the session transcript: a shell tool result that
 * CREATED a comment carries the command and the returned comment id/URL.
 *
 * This module extracts the set of comment identifiers a session posted from
 * its transcript `tool_result` entries. Only creations attribute; reads and
 * lists do not, so a session that merely inspected a comment still receives
 * the event. Identifiers are canonical: `ic:<id>` for conversation (issue)
 * comments, `rc:<id>` for inline pull-request review comments.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Canonical identifier for a conversation (issue) comment. */
export function issueCommentKey(id: string | number): string {
  return `ic:${id}`;
}

/** Canonical identifier for an inline pull-request review comment. */
export function reviewCommentKey(id: string | number): string {
  return `rc:${id}`;
}

const SHELL_TOOL_NAMES = new Set(['run_shell_command', 'shell']);

/**
 * A comment subcommand must sit at the COMMAND position (optionally behind a
 * wrapper or environment assignment), not merely appear as a substring: a shell
 * comment `… # gh pr comment` or an unquoted `grep gh pr comment …` is a read.
 * Reads/lists never match, so inspecting a comment never suppresses its
 * delivery. Review bodies (`gh pr review`, `pulls/<n>/reviews`) are out of scope
 * — the watch does not deliver them — and a review-object id lives in a
 * different id table than inline review comments, so they are not recognized.
 */
const SUBCOMMAND_STAGE_START =
  /^\s*(?:(?:env|time|nohup|command|sudo)\s+(?:(?:-[A-Za-z][A-Za-z-]*(?:\s+(?!gh\b)[^\s]+)?|[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+)*|[A-Za-z_][A-Za-z0-9_]*=(?:\$\(|`)\s*|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*gh\s+(?:pr|issue)\s+comment\b/;

/**
 * Leads a `gh`/`curl` invocation (read or write), with the same wrapper /
 * assignment prefixes the creation recognition accepts (so `env -u VAR gh api`
 * counts too). Used to count the API commands in a chain: a second one means the
 * comment-shaped output cannot be proven to be the creation's.
 */
const API_COMMAND_LEAD =
  /^\s*(?:(?:env|time|nohup|command|sudo)\s+(?:(?:-[A-Za-z][A-Za-z-]*(?:\s+(?!gh\b)[^\s]+)?|[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+)*|[A-Za-z_][A-Za-z0-9_]*=(?:\$\(|`)\s*|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*(?:gh|curl)\b/;

const PATH_PATTERNS: readonly RegExp[] = [
  // gh api / curl writing to a comments collection.
  /\bgh\s+api\b[\s\S]*?\b(?:issues|pulls)\/\d+\/comments\b[\s\S]*?(?:-X\s+POST|--method\s+POST|-f\s|--field\s|-F\s|--raw-field\s|--input\s)/,
  // gh api can put the write flags before the collection path too
  // (`gh api --method POST --input p.json repos/o/r/issues/5/comments`).
  /\bgh\s+api\b[\s\S]*?(?:-X\s+POST|--method\s+POST|-f\s|--field\s|-F\s|--raw-field\s|--input\s)[\s\S]*?\b(?:issues|pulls)\/\d+\/comments\b/,
  /\bcurl\b[\s\S]*?\brepos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\/\d+\/comments\b[\s\S]*?(?:-X\s+POST|--request\s+POST|-d\s|--data\b)/,
  // curl commonly puts the write flags before the URL.
  /\bcurl\b[\s\S]*?(?:-X\s+POST|--request\s+POST|-d\s|--data\b)[\s\S]*?\brepos\/[^/\s]+\/[^/\s]+\/(?:issues|pulls)\/\d+\/comments\b/,
];

/**
 * An explicit GET is a read even when field flags are present: `gh api` sends
 * `-f`/`-F` values as query parameters on a GET, so
 * `gh api …/comments --method GET --paginate -F per_page=100` lists comments
 * and must never attribute them. Without this veto the field-flag creation
 * pattern matches and a session that only read comments is recorded as their
 * author, permanently withholding events it should receive.
 */
const EXPLICIT_GET_PATTERN = /(?:--method[=\s]+|--request[=\s]+|-X\s*)GET\b/i;

/**
 * A quoted GET method value (`--method "GET"`, `-X 'GET'`, `--request "GET"`) is
 * a real GET flag; unwrap it so the veto still sees it after quote-stripping. GET
 * text inside a quoted body (`-f body='--method GET'`) is not a flag and must not
 * veto a POST.
 */
const QUOTED_GET_VALUE_PATTERN =
  /(--method[=\s]+|--request[=\s]+|-X\s*)["']GET["']/gi;

/**
 * Drop quoted spans so a creation subcommand or write flag inside a quoted
 * argument is not mistaken for the real command: `grep 'gh pr comment' …` is a
 * read, and `--jq '.[] | .id'` must not fragment the pipeline split below.
 * Best-effort (escaped quotes are not modeled), consistent with the module's
 * best-effort attribution that fails open toward delivery.
 */
function stripQuotedSpans(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * Drop a trailing shell comment: an unquoted `#` at the start of a word begins
 * a comment, so `gh api …/comments --jq … # gh pr comment` is a read, not a
 * creation. A `#` inside quotes (a body) or inside a word (`foo#bar`, a URL
 * fragment) is not a comment. Best-effort, like the quote handling.
 */
function stripShellComment(segment: string): string {
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(segment[i - 1]!))) {
      return segment.slice(0, i);
    }
  }
  return segment;
}

/**
 * Whether position `i` sits at an unescaped shell word boundary, where a `#`
 * would begin a comment. The preceding character must be whitespace or a
 * separator, and must not itself be escaped: in `tee review\ #1.md` the space
 * is escaped (odd number of preceding backslashes), so `#1.md` stays part of
 * the filename word and is not a comment.
 */
function isUnescapedWordBoundary(command: string, i: number): boolean {
  if (i === 0) return true;
  const prev = command[i - 1]!;
  if (!/[\s;|&]/.test(prev)) return false;
  let backslashes = 0;
  let k = i - 2;
  while (k >= 0 && command[k] === '\\') {
    backslashes++;
    k--;
  }
  return backslashes % 2 === 0;
}

/**
 * Remove heredoc bodies before segmentation. A heredoc body is data written to
 * a file/stdin, not shell structure: a quote character in the body (e.g. the
 * apostrophe in `it's quoted`) must not open a shell quote that swallows the
 * creation command following the heredoc, and creation-shaped text inside the
 * body must not be scanned as a creation. Consume each `<<DELIM` / `<<-DELIM` /
 * `<<'DELIM'` / `<<"DELIM"` body up to its delimiter line, keeping the command
 * line that carries the redirection and the line boundary after it, so the next
 * command is segmented normally. A herestring (`<<<`) is not a heredoc. The
 * body is stripped only when its delimiter line is actually present; otherwise
 * (an arithmetic `<<` or a malformed heredoc) the text is left for normal
 * processing rather than swallowing the commands that follow. Best-effort,
 * like the quote handling.
 */
function stripHeredocBodies(command: string): string {
  // Shell removes a backslash-newline line continuation before parsing, joining
  // the lines. Normalize it to a space (as segmentation does) so a `#` that
  // follows a continuation is judged against the joined line: in `: \<newline>
  // # Use <<'EOF' …` the `#` begins a real comment, not an escaped word.
  command = command.replace(/\\\r?\n/g, ' ');
  let result = '';
  let quote: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote !== null) {
      result += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
      i++;
      continue;
    }
    // A word-initial `#` begins a shell comment: copy it verbatim to the end of
    // the line WITHOUT interpreting a `<<` inside it as a heredoc. Otherwise a
    // comment such as `# Use <<'EOF' for the note` would start heredoc
    // consumption and, on finding a later real heredoc's delimiter line, delete
    // the commands in between (including a real read), corrupting the origin
    // check. Segmentation drops the comment itself later. The boundary must be
    // unescaped, so the `#` in `tee review\ #1.md` (part of the filename) does
    // not hide the real heredoc that follows it.
    if (ch === '#' && isUnescapedWordBoundary(command, i)) {
      while (i < command.length && command[i] !== '\n' && command[i] !== '\r') {
        result += command[i];
        i++;
      }
      continue;
    }
    // A herestring (<<<) is not a heredoc; consume all three so the trailing
    // two are not re-read as a `<<` heredoc on the next iteration.
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      result += '<<<';
      i += 3;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === '-') {
        stripTabs = true;
        j++;
      }
      while (command[j] === ' ' || command[j] === '\t') j++;
      let delim = '';
      const dq = command[j];
      if (dq === "'" || dq === '"') {
        j++;
        while (j < command.length && command[j] !== dq) {
          delim += command[j];
          j++;
        }
        if (j < command.length) j++;
      } else {
        while (j < command.length && !/[\s;|&<>]/.test(command[j]!)) {
          delim += command[j];
          j++;
        }
        // A backslash before/within the delimiter quotes it (<<\EOF is <<'EOF'):
        // the delimiter word itself has the backslashes removed.
        delim = delim.replace(/\\/g, '');
      }
      if (delim === '') {
        result += command.slice(i, j);
        i = j;
        continue;
      }
      // The body starts on the next line; find the end of the current line.
      let lineEnd = j;
      while (
        lineEnd < command.length &&
        command[lineEnd] !== '\n' &&
        command[lineEnd] !== '\r'
      ) {
        lineEnd++;
      }
      if (lineEnd >= command.length) {
        result += command.slice(i, j);
        i = j;
        continue;
      }
      let bodyStart = lineEnd + 1;
      if (command[lineEnd] === '\r' && command[lineEnd + 1] === '\n') {
        bodyStart = lineEnd + 2;
      }
      // Only strip when the delimiter line actually exists. Otherwise (an
      // arithmetic `<<` or a malformed heredoc) fall back to normal processing
      // instead of swallowing the commands that follow.
      let scan = bodyStart;
      let afterDelim = -1;
      while (scan < command.length) {
        let le = command.indexOf('\n', scan);
        if (le === -1) le = command.length;
        let line = command.slice(scan, le);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === delim) {
          afterDelim = le + 1;
          break;
        }
        scan = le + 1;
      }
      if (afterDelim === -1) {
        result += command.slice(i, i + 2);
        i += 2;
        continue;
      }
      // Keep the command line carrying the redirection (through its newline)
      // and skip the body plus the delimiter line.
      result += command.slice(i, bodyStart);
      i = afterDelim;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Split a shell chain into pipeline stages on separators OUTSIDE quotes only.
 * A write flag must sit in the SAME stage as the collection path to count as a
 * creation: `gh api …/comments --jq … ; stat -f '%Sm' …` is a GET listing
 * followed by an unrelated `-f`, not a POST. Splitting inside quotes would also
 * tear a read-only search such as `rg 'gh api|gh pr comment' …` into unbalanced
 * fragments and mistake the quoted `gh pr comment` for a real creation, so a
 * separator only ends a stage when no quote is open. A newline is a boundary
 * too. Best-effort: escaped quotes are not modeled.
 */
function commandSegments(command: string): string[] {
  command = stripHeredocBodies(command);
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // An unquoted word-initial `#` begins a shell comment: ignore the rest of
    // the line INCLUDING any separators in it, so `cat urls.txt # inspect; gh
    // pr comment …` does not split the comment's `;` into a phantom creation.
    if (
      ch === '#' &&
      (i === 0 || /\s/.test(command[i - 1]!) || current.trim() === '')
    ) {
      while (
        i + 1 < command.length &&
        command[i + 1] !== '\n' &&
        command[i + 1] !== '\r'
      ) {
        i++;
      }
      continue;
    }
    // A backslash-newline is a line continuation, not a command boundary: the
    // write flag on the continued line belongs to the same stage as the path.
    if (
      ch === '\\' &&
      (command[i + 1] === '\n' ||
        (command[i + 1] === '\r' && command[i + 2] === '\n'))
    ) {
      current += ' ';
      i += command[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      // `&&` ends a stage; `&>` and `>&` are redirections, not boundaries; a
      // lone `&` backgrounds the command and ends the stage.
      if (command[i + 1] === '&') {
        segments.push(current);
        current = '';
        i++;
      } else if (command[i + 1] === '>' || current.endsWith('>')) {
        current += ch;
      } else {
        segments.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * A path-based creation must be led by `gh api` / `curl`, optionally behind a
 * wrapper command (env/time/nohup/command/sudo with its flags/assignments), an
 * assignment capture (`cid=$(…)` / backticks), or bare environment assignments
 * (`FOO=1 gh api …`). The lead-in is what rejects a read-only search that merely
 * quotes a creation (`rg 'gh api … -X POST'`): its stage starts with the search
 * tool, not a wrapper or the API command. A flag's optional value never consumes
 * the `gh` of `gh api`.
 */
const API_STAGE_START =
  /^\s*(?:(?:env|time|nohup|command|sudo)\s+(?:(?:-[A-Za-z][A-Za-z-]*(?:\s+(?!gh\b)[^\s]+)?|[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+)*|[A-Za-z_][A-Za-z0-9_]*=(?:\$\(|`)\s*|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*(?:gh\s+api|curl)\b/;

function segmentIsCreation(rawSegment: string): boolean {
  // A trailing shell comment is not part of the command: `… # gh pr comment`
  // must not pass for a creation.
  const segment = stripShellComment(rawSegment);
  // An explicit GET is a read even with field flags (gh api sends them as query
  // parameters on a GET). Unwrap a quoted GET method value first so the veto
  // still sees it, then strip quoted spans so GET text inside a body does not
  // veto a genuine POST.
  const getProbe = stripQuotedSpans(
    segment.replace(QUOTED_GET_VALUE_PATTERN, '$1GET'),
  );
  if (EXPLICIT_GET_PATTERN.test(getProbe)) return false;
  const stripped = stripQuotedSpans(segment);
  // curl -G / --get sends a GET even when -d/--data is present (the data becomes
  // query parameters), so a -G listing is a read, not a creation.
  if (
    /\bcurl\b/.test(stripped) &&
    /(?:^|\s)(?:--get|-[A-Za-z]*G[A-Za-z]*)(?:\s|$)/.test(stripped)
  ) {
    return false;
  }
  // The subcommand must be at the command position, not a substring of a comment
  // or a search argument.
  if (SUBCOMMAND_STAGE_START.test(stripped)) return true;
  // A quoted collection path still counts, so test the path patterns on a copy
  // with quote characters removed (content kept). Require the stage to be led by
  // gh api / curl (possibly behind a wrapper or capture) so a read-only search
  // quoting such a command is not mistaken for a creation.
  const unwrapped = segment.replace(/['"]/g, '');
  if (
    API_STAGE_START.test(unwrapped) &&
    PATH_PATTERNS.some((pattern) => pattern.test(unwrapped))
  ) {
    return true;
  }
  return false;
}

/** The first stage that is a creation, for both detection and target typing. */
function creationSegment(command: string): string | undefined {
  return commandSegments(command).find((segment) => segmentIsCreation(segment));
}

/**
 * Split a (heredoc-stripped) command into INDEPENDENT commands on `;`, `&&`,
 * `||`, a backgrounding `&`, and newlines — but NOT on a pipe `|`, which keeps a
 * pipeline together (a downstream filter such as `tee` passes the creation's
 * output through). Quote- and comment-aware, like segmentation.
 */
function splitIndependentCommands(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (
      ch === '#' &&
      (i === 0 || /\s/.test(command[i - 1]!) || current.trim() === '')
    ) {
      while (
        i + 1 < command.length &&
        command[i + 1] !== '\n' &&
        command[i + 1] !== '\r'
      ) {
        i++;
      }
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      parts.push(current);
      current = '';
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        parts.push(current);
        current = '';
        i++;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        parts.push(current);
        current = '';
        i++;
      } else if (command[i + 1] === '>' || current.endsWith('>')) {
        current += ch;
      } else {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Whether the command redirects its STDOUT (so it contributes no visible
 * output). A `>`/`1>`/`>>`/`&>` redirect sends stdout away; a `2>` (or other
 * non-1 fd) redirect only touches stderr and leaves stdout visible. Operate on
 * a quote-stripped probe so a `>` inside a body does not count.
 */
function hasStdoutRedirect(probe: string): boolean {
  return /(?:^|[^\d])(?:1?>|&>)/.test(probe);
}

/**
 * Whether the command writes nothing to stdout, so it cannot be the source of
 * the visible comment-shaped output. State-changing builtins (`cd`, `unset`,
 * `shift`, `wait`, `read`, …) produce no stdout, and a bare shell closer such as
 * `)` is not a command at all. Counting these as stdout writers would veto
 * legitimate `cd … && create` chains. A leading `(`/`)` and whitespace are
 * stripped first so a subshell's `(cd …` is recognised too.
 *
 * `export` and `set` are only silent for operand shapes that PROVABLY cannot
 * print (`export NAME=…`, `set -e`). Bare, they print the variables, and so do
 * `export -p`, `set -o` and `set +o`. The shell removes quotes, backslashes and
 * ANSI-C `$'…'` before the builtin sees its arguments, and an expansion can turn
 * into a printing flag (`export $FLAGS` with `FLAGS=-p`), so silence is granted
 * only to literal words of a known-silent shape — never to a word whose text we
 * cannot resolve. Over-counting a producer only costs an attribution; crediting
 * a reader as an author would withhold a comment it never wrote.
 */
const NO_STDOUT_FIRST_WORDS = new Set([
  'cd',
  'unset',
  'shift',
  'wait',
  'read',
  'return',
  'exit',
  'break',
  'continue',
  'true',
  'false',
  ':',
]);

/**
 * Characters that cannot take part in ANY shell expansion when unquoted, so a
 * word built only from them is provably literal. This is a whitelist on
 * purpose: enumerating dangerous characters kept missing one (`*?[`, then
 * extglob `@(…)`, `+(…)`, `!(…)`), and each miss let `nullglob` delete the word
 * and turn `set <pattern>` into a bare, printing `set`. `@` and `+` are safe
 * alone — extglob needs the `(`, which is not in the set.
 */
const LITERAL_WORD_CHAR = /[A-Za-z0-9_=./:@%+,-]/;

/**
 * An operand word after the shell's quote removal. `expandable` records that
 * the word contains an UNQUOTED character outside the literal set, so the shell
 * may still expand it, split it, or delete it. Characters taken from inside
 * quotes or after a backslash are literal and never set the flag — `set "$E"`
 * keeps one empty positional parameter, while `set $E` can vanish entirely.
 */
interface ShellWord {
  text: string;
  expandable: boolean;
}

/**
 * Split operand text into words and remove the quoting the shell removes:
 * quote delimiters, `\x` escapes and the `$` of an ANSI-C `$'…'`. Expansions are
 * NOT performed; a word that could still be expanded is flagged so the caller
 * refuses to prove anything about it.
 */
function shellWords(text: string): ShellWord[] {
  const words: ShellWord[] = [];
  let current = '';
  let expandable = false;
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        current += text[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      started = true;
      continue;
    }
    if (ch === '$' && text[i + 1] === "'") {
      quote = "'";
      started = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push({ text: current, expandable });
        current = '';
        expandable = false;
        started = false;
      }
      continue;
    }
    if (!LITERAL_WORD_CHAR.test(ch)) expandable = true;
    current += ch;
    started = true;
  }
  if (started) words.push({ text: current, expandable });
  return words;
}

/**
 * `set` prints with no operands and for a trailing `-o`/`+o` (which list the
 * options). Any other literal option cluster or positional word is silent; a
 * cluster containing `p` is refused outright, since `export`-style printing is
 * the failure this guards and `set -p` costs at most one attribution.
 */
function setOperandsAreSilent(words: ShellWord[]): boolean {
  if (words.length === 0) return false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    // Past `--` nothing is an option, and `set` with positional parameters never
    // prints — even if a later word expands away or matches no file.
    if (word.text === '--') return true;
    if (/^[-+][A-Za-z]+$/.test(word.text)) {
      if (word.text.includes('p')) return false;
      if (word.text.endsWith('o') && i === words.length - 1) return false;
      continue;
    }
    if (word.expandable) return false;
  }
  return true;
}

function writesNoStdout(command: string): boolean {
  const words = shellWords(command.replace(/^[()\s]+/, ''));
  const first = words[0]?.text;
  if (first === undefined) return true;
  if (NO_STDOUT_FIRST_WORDS.has(first)) return true;
  const operands = words.slice(1);
  if (first === 'export') {
    // A literal `NAME` / `NAME=value` word can never be read as an option. It
    // must also survive the shell: any expandable operand could be deleted by
    // `nullglob`, leaving a bare `export`. That refuses `export PATH=$PATH:/x`,
    // which bash itself keeps, because the expanded word cannot be proven to
    // survive in every shell — a lost attribution, never a wrong one.
    return (
      operands.length > 0 &&
      operands.every(
        (word) =>
          !word.expandable &&
          /^[A-Za-z_][A-Za-z0-9_]*(?:=[\s\S]*)?$/.test(word.text),
      )
    );
  }
  if (first === 'set') return setOperandsAreSilent(operands);
  return false;
}

/**
 * Whether a pipeline's downstream stage provably passes the creation's stdout
 * through. `tee` copies stdin to stdout (its operands are output FILES) and a
 * bare `cat` reads stdin. Any other stage may ignore stdin and print its own
 * output — `create | cat url.txt` prints the FILE, not the creation's result —
 * so the origin is no longer provable and nothing is attributed. An input
 * redirect overrides the pipe as well: in `create | tee < url.txt` the `tee`
 * reads the FILE, so even a passthrough command no longer proves the source.
 */
function passesStdinThrough(rawStage: string): boolean {
  const stage = stripQuotedSpans(stripShellComment(rawStage)).trim();
  // `< file` and `<<< word` both replace the pipe as this stage's stdin.
  if (stage.includes('<')) return false;
  return /^tee(?:\s|$)/.test(stage) || stage === 'cat';
}

/**
 * Whether the creation's output cannot be proven to be the result we see. The
 * visible stdout must be provably the creation's: attribute only when exactly
 * ONE independent command writes to stdout and that command leads with the
 * creation. Any other stdout-producing command — before OR after the creation,
 * API or not (`cat url.txt` prints a comment URL just as a read does) — makes
 * the origin unprovable. A command whose stdout is redirected (`> file`,
 * `>/dev/null`, `&>`), a pure assignment, or a no-stdout builtin (`cd`, `unset`,
 * `shift`, `wait`, …; `export`/`set` only in provably silent operand forms) /
 * bare shell closer contributes no visible output and does not block: the heredoc that
 * writes the body to a file still lets the creation that follows it attribute,
 * and `cd … && create` is not vetoed. A stderr-only redirect (`2>`) does NOT
 * silence stdout. A pipe keeps a pipeline together only while every downstream
 * stage provably passes that stdout through (`create | tee`, `create | cat`);
 * `create | cat url.txt` prints a FILE, and an input redirect overrides the pipe
 * (`create | tee < url.txt`), so both attribute nothing. Silence is judged from
 * the argument TEXT with the shell's own quote removal, never from
 * quote-stripped spans — `export '-p'`, `export \-p` and `export $'-p'` all print
 * just like `export -p`, and only literal `NAME`/`NAME=value` operands (or a
 * provably silent `set` option list) are exempt, where "literal" is a whitelist
 * of characters that cannot expand (see LITERAL_WORD_CHAR) rather than a list
 * of dangerous ones: `nullglob` deletes `set *` and extglob `set @(zzz)` alike,
 * leaving a bare, printing `set`. Quoted characters are literal and stay exempt.
 * A shell conditional/loop is ambiguous (static analysis cannot prove which
 * branch executed). When the source cannot be proven, attribute nothing
 * (fail-open: the author may self-echo once, but a mere reader is never
 * credited with comments it only read).
 */
function creationOutputIsAmbiguous(command: string): boolean {
  const stripped = stripHeredocBodies(command);
  const segments = commandSegments(stripped).map((segment) =>
    stripQuotedSpans(stripShellComment(segment)),
  );
  if (
    segments.some((segment) =>
      /^\s*(?:if|then|else|elif|fi|case|esac|while|until|for|do|done)\b/.test(
        segment,
      ),
    )
  ) {
    return true;
  }
  const apiCommands = segments.filter((segment) =>
    API_COMMAND_LEAD.test(segment),
  );
  if (apiCommands.length >= 2) return true;
  // Structural source proof over the WHOLE command: count the independent
  // commands that write to stdout; the creation must be the only one.
  const producers: string[] = [];
  for (const independent of splitIndependentCommands(stripped)) {
    const probe = stripQuotedSpans(stripShellComment(independent)).trim();
    if (probe === '') continue;
    if (hasStdoutRedirect(probe)) continue;
    // Silence is decided on the argument TEXT, never on quote-stripped spans:
    // stripping turns `export '-p'` into `export ''`, an empty operand that
    // would look silent even though the shell prints the variables.
    if (writesNoStdout(stripShellComment(independent).trim())) continue;
    // A pure assignment produces no stdout; an env-prefixed creation does (and
    // is recognised as a creation, so it is not excluded here).
    if (
      !segmentIsCreation(independent) &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(probe)
    ) {
      continue;
    }
    producers.push(independent);
  }
  if (producers.length !== 1) return true;
  const stages = commandSegments(producers[0]!).filter(
    (stage) => stage.trim() !== '',
  );
  if (stages.length === 0 || !segmentIsCreation(stages[0]!)) return true;
  // Leading the pipeline is not enough: every downstream stage must provably
  // pass that stdout through, or it may print its own output instead.
  return stages.slice(1).some((stage) => !passesStdinThrough(stage));
}

/**
 * Which collection the creation stage targeted, for bare JSON `id`s. Inspect the
 * creation stage only, so a command that also reads another collection does not
 * key the created id to the wrong one.
 */
function creationTarget(
  segment: string,
): 'issue-comment' | 'review-comment' | undefined {
  const unwrapped = segment.replace(/['"]/g, '');
  if (/\bissues\/\d+\/comments\b/.test(unwrapped)) return 'issue-comment';
  if (/\bpulls\/\d+\/comments\b/.test(unwrapped)) return 'review-comment';
  return undefined;
}

/**
 * The leading balanced `{…}` object, tolerating a trailer: real creations often
 * print the JSON object and then a status line (`…}\nALL DONE`). Returns the
 * object's substring, or undefined when the braces never balance. Braces inside
 * JSON strings do not count. The caller still requires the output to start with
 * `{`, so this only relaxes the trailing edge, not the leading one.
 */
function leadingJsonObject(text: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return undefined;
}

/**
 * Extract posted comment identifiers from one parsed transcript entry.
 * Returns an empty array for anything that is not a shell creation result.
 * Never throws on malformed input.
 */
export function extractPostedCommentIds(entry: unknown): string[] {
  if (entry === null || typeof entry !== 'object') return [];
  const record = entry as Record<string, unknown>;
  if (record['type'] !== 'tool_result') return [];
  const message = record['message'];
  if (message === null || typeof message !== 'object') return [];
  const parts = (message as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts)) return [];

  const ids = new Set<string>();
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const functionResponse = (part as Record<string, unknown>)[
      'functionResponse'
    ];
    if (functionResponse === null || typeof functionResponse !== 'object') {
      continue;
    }
    const fr = functionResponse as Record<string, unknown>;
    const name = fr['name'];
    if (typeof name !== 'string' || !SHELL_TOOL_NAMES.has(name)) continue;
    const response = fr['response'];
    if (response === null || typeof response !== 'object') continue;
    const output = (response as Record<string, unknown>)['output'];
    if (typeof output !== 'string') continue;

    // The shell tool echoes "Command: <cmd>\nDirectory: ...\nOutput: <result>".
    const command =
      output.match(/^Command: ([\s\S]*?)\nDirectory:/)?.[1] ??
      output.match(/^Command: ([\s\S]*?)\nOutput:/)?.[1] ??
      '';
    const segment = command ? creationSegment(command) : undefined;
    if (!segment) continue;
    const result =
      output.match(/\nOutput: ([\s\S]*?)\nError:/)?.[1] ??
      output.match(/\nOutput: ([\s\S]*)$/)?.[1] ??
      '';

    // The output must be attributable to the creation. When another gh/curl
    // command runs AFTER the creation, it may have produced the output —
    // whatever its shape (URL, JSON object, or bare id) — so attribute nothing
    // (fail-open: the author may self-echo once, but a mere reader is never
    // credited with comments it only read). This gates every result shape below,
    // not just the bare-URL one.
    if (creationOutputIsAmbiguous(command)) continue;

    // Harvest only a creation-shaped response, never a listing or free text.
    // Prefer the structured result: a single JSON object's top-level id is the
    // created comment, and a URL quoted inside its body is data, not another
    // posted comment — so do not URL-scan a structured result. A bare id is the
    // `--jq '.id'` shape; a single comment URL is the `gh pr comment` shape.
    const target = creationTarget(segment);
    const trimmed = result.trim();
    const keyFor = (id: string | number): string =>
      target === 'issue-comment' ? issueCommentKey(id) : reviewCommentKey(id);
    if (target && trimmed.startsWith('{')) {
      // A creation may print the JSON object plus a trailer line (`…}\nALL
      // DONE`); parse the leading balanced object rather than requiring the
      // whole output to be JSON.
      const objectText = leadingJsonObject(trimmed);
      try {
        const parsed: unknown =
          objectText === undefined ? undefined : JSON.parse(objectText);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          const id = (parsed as { id?: unknown }).id;
          if (typeof id === 'number' && Number.isSafeInteger(id)) {
            ids.add(keyFor(id));
            continue;
          }
        }
      } catch {
        // Not JSON; fall through to the bare shapes.
      }
    }
    if (target && /^\d+$/.test(trimmed)) {
      ids.add(keyFor(trimmed));
      continue;
    }
    const urlMatches = [...result.matchAll(/issuecomment-(\d+)/g)].map((m) =>
      issueCommentKey(m[1]!),
    );
    urlMatches.push(
      ...[...result.matchAll(/discussion_r(\d+)/g)].map((m) =>
        reviewCommentKey(m[1]!),
      ),
    );
    if (urlMatches.length === 1) {
      ids.add(urlMatches[0]!);
    }
  }
  return [...ids];
}

interface TranscriptScanCache {
  size: number;
  mtimeMs: number;
  /** Bytes consumed up to (and including) the last complete newline. */
  offset: number;
  ids: Set<string>;
}

const scanCache = new Map<string, TranscriptScanCache>();

/**
 * Bound the cache like the worker's wake-cwd cache: each entry retains a full
 * id set for the life of the process, so an unbounded map would grow with every
 * session ever looked up. Evict the oldest entry when full; an evicted session
 * simply rescans on its next lookup.
 */
const MAX_TRANSCRIPT_SCAN_CACHE = 256;

/** Test hook: drop cached scans (e.g. when a fixture rewrites a transcript). */
export function clearPostedCommentScanCache(): void {
  scanCache.clear();
}

async function readRange(
  path: string,
  start: number,
  end: number,
): Promise<string> {
  if (end <= start) return '';
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start, end: end - 1 });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Return the set of comment identifiers the session at `transcriptPath` has
 * posted, scanning incrementally: an unchanged file is answered from cache,
 * a grown file scans only the appended bytes, and a shrunk file rescans from
 * the start. Transcripts are append-only per session, so growth is treated as
 * an append; a file replaced in place by a larger one is not detected (the
 * per-session path makes this a non-goal). A missing or unreadable transcript
 * yields an empty set (fail-open for delivery) — the caller logs it; it is
 * never a reason to prune bindings.
 */
export async function postedCommentIdsForTranscript(
  transcriptPath: string,
): Promise<ReadonlySet<string>> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(transcriptPath);
  } catch {
    scanCache.delete(transcriptPath);
    return new Set();
  }
  if (!stats.isFile()) return new Set();

  const cached = scanCache.get(transcriptPath);
  if (
    cached &&
    cached.size === stats.size &&
    cached.mtimeMs === stats.mtimeMs
  ) {
    return cached.ids;
  }

  let offset = 0;
  let ids = new Set<string>();
  if (cached && stats.size > cached.size) {
    offset = cached.offset;
    ids = new Set(cached.ids);
  }

  let text: string;
  try {
    text = await readRange(transcriptPath, offset, stats.size);
  } catch {
    return cached?.ids ?? new Set();
  }

  // Consume only complete lines; leave a trailing partial line for the next
  // scan so a mid-write append is never parsed as a broken record.
  const lastNewline = text.lastIndexOf('\n');
  const consumable = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const consumedBytes = Buffer.byteLength(consumable, 'utf8');
  for (const line of consumable.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const id of extractPostedCommentIds(entry)) ids.add(id);
  }

  if (
    scanCache.size >= MAX_TRANSCRIPT_SCAN_CACHE &&
    !scanCache.has(transcriptPath)
  ) {
    const oldest = scanCache.keys().next().value;
    if (oldest !== undefined) scanCache.delete(oldest);
  }
  scanCache.set(transcriptPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    offset: offset + consumedBytes,
    ids,
  });
  return ids;
}
