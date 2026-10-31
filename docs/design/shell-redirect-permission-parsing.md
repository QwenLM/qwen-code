# Shell Redirection Parsing for Permission Rules

[English](shell-redirect-permission-parsing.md) | [简体中文](shell-redirect-permission-parsing.zh-CN.md)

## Status

Implemented. This is the first of three changes for #10196; the other two resolve variables the check can know and handle paths the shell only produces at run time.

## Problem

`Read`, `Edit`, `Write` and `WebFetch` rules reach shell commands through the file operations extracted from the command text, so a `Bash(...)` allow rule cannot outrank a file deny. The extractor's tokenizer discarded quoting, and its redirection parser recognised a fixed list of operator spellings. As a result:

- Writes spelled `3>file`, `>|file`, `<>file`, `>&file`, `exec 3>file`, or with the operator glued to the previous word (`printf X>file`) produced no write, so a `Bash(...)` allow rule ran them past an `Edit(...)` or `Write(...)` deny.
- A quoted or escaped `>` counted as a redirection. `grep ">" .env` became a write to `.env` instead of a read, so a `Read(.env)` deny did not apply while a bare `Write` deny refused the command.
- fd plumbing counted as a file: `2>&1` became a write to a file named `&1`, and `> /dev/null` a write to `/dev/null`.
- `#` comments, the comparisons in `[[ a > b ]]`, `(( a > b ))` and `$(( a > b ))`, and a `>` inside `${…}` produced writes.
- The compound-command splitter read `>|` as a pipe and cut `printf X >| p.txt` into `printf X >` and `p.txt`.
- Prefix commands (`sudo`, `env`, `timeout`, …) joined their words back with spaces, so `sudo cat "my notes.txt"` read two files, and `sudo bash -c '…'` was not unwrapped. Their options were matched as whole words, so a grouped option (`sudo -Eu root cat .env`) or an `env` option value (`env -u FOO cat .env`, `env -C dir …`) was taken for the command.

## Goals

- Every bash redirection form yields the read or write it performs.
- Only unquoted `<` and `>` are redirections.
- fd duplication and closing, and device targets such as `/dev/null`, are not file operations.
- No file access the previous extractor reported is lost, apart from the spurious ones listed above.

## Non-goals

- Changing which redirection targets count as files. Targets still go through the same path heuristic as command arguments, so `> "$OUT"` stays unanalysed here.
- Resolving variables (`$PWD`, values assigned earlier in the command), brace expansion and `$'…'` strings.
- Treating `$(…)` as one word and analysing its body. On its own that would drop the coverage the old whitespace splitting gave `cat $(echo .env)` by accident, so it lands with the handling of paths known only at run time.

## Design

### Tokenizer

Each character of a word records how it was written: unquoted, inside double quotes, or literal (single quotes or a backslash escape). The text after quote removal is the same as before, so every command handler sees the same words. An unquoted `#` at the start of a word ends the command; inside a word, as in `""#x`, it is text. A `${…}` or `$((…))` expansion stays in one word, as in bash: its spaces, `<`, `>` and `#` belong to the expansion, not to the command. A `#` inside backquotes comments out only the inner command, so it does not end this one.

### Redirections

A word is split at its unquoted `<` and `>` characters, except `<(` and `>(`, which start a process substitution. A run of digits or `&` before the first operator is its fd. Each piece is matched against one pattern covering `>`, `>>`, `>|`, `>&`, `<`, `<&`, `<>`, `<<`, `<<-` and `<<<`. When the target is not glued to the operator, it is the next word, which is split the same way: its part before any operator is the target and the rest are further redirections, so `printf X > a>p.txt` writes `a` and then `p.txt`. Shell syntax glued to the end of the word in front is dropped, as for any word, so `cat .env&>f` and `(cat .env)>f` read `.env`.

- `<` and `<&` read, `<>` reads and writes, the others write.
- `>&N`, `>&-` and `N<&M-` duplicate or close fds and touch no file.
- Heredocs and here-strings carry data, not file names.
- `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/N` and the `/dev/tcp` and `/dev/udp` sockets are not files.
- A `[[ … ]]` test compares. `[[` opens one only as the command word, possibly after `!`, `if`, `while` and similar reserved words, and only when a `]]` follows, alone or with a redirection glued after it (`]]>out`); anywhere else it is an argument and hides nothing.
- A command that is a whole `(( … ))` is arithmetic. Without the closing `))`, as in `((cat .env); true)`, bash reads nested subshells, which are analysed as usual.

A process substitution word (`<(cmd)`) is a pipe, so it is not a path argument either.

### Prefix commands

The words after a prefix command are quoted again before they are parsed a second time, and the inner command is walked like any compound command, so a wrapped `bash -c '…'` is unwrapped. Options are read the way getopt reads them: short options group, a value is glued or the next word, a long option takes `--name=value`, and `--` ends them. `env -C DIR` runs the command in DIR. `env -S STRING` splits STRING into more words for env, so they are analysed as env runs them; quoting the words again would otherwise keep `env -S 'cat .env'` as one word that names no command.

### Compound splitting

`>|` is a redirection, so the splitter no longer cuts at its `|`. The `>` must be shell syntax: after a quoted or escaped `>`, as in `echo \>| cat .env`, the `|` is still a pipe.

## Risks

- More reads and writes are reported, so users with file rules may see a prompt or denial where none appeared before. Each one is an access the command really performs.
- The tokenizer still does not model every bash construct (substitution bodies, here-doc contents). Those keep their previous behaviour.

## Validation

- Unit tests for each redirection form, the non-file targets, quoting, comments, `[[ ]]`, `(( ))`, `$(( ))`, `${…}`, prefix commands and the `>|` split.
- Permission-level tests: a `Bash(*)` allow rule does not outrank `Edit(p.txt)` or `Read(.env)` denies through these forms, and fd plumbing is not a write under a bare `Write` deny.
- A comparison of 1,260 command and rule pairs against the previous extractor. No verdict became more permissive except the spurious writes listed under Problem.
- The flow in `.qwen/e2e-tests/2026-10-13-shell-redirect-permissions.md`, run headless against the released `qwen` 0.24.6 and this change. All eight cases flipped as expected: the six redirections that read `.env` or wrote `protected.txt` before are now denied, and the two fd-plumbing commands a bare `Write` deny refused before now run.
