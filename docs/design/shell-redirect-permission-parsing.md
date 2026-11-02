# Shell Redirection Parsing for Permission Rules

[English](shell-redirect-permission-parsing.md) | [简体中文](shell-redirect-permission-parsing.zh-CN.md)

## Status

Implemented. This is the first of three changes for #10196; the other two resolve variables the check can know and handle paths the shell only produces at run time.

## Problem

`Read`, `Edit`, `Write` and `WebFetch` rules reach shell commands through the file operations extracted from the command text, so a `Bash(...)` allow rule cannot outrank a file deny. The extractor's tokenizer discarded quoting, and its redirection parser recognised a fixed list of operator spellings. As a result:

- Writes spelled `3>file`, `>|file`, `<>file`, `>&file`, `exec 3>file`, or with the operator glued to the previous word (`printf X>file`) produced no write, so a `Bash(...)` allow rule ran them past an `Edit(...)` or `Write(...)` deny.
- A quoted or escaped `>` counted as a redirection. `grep ">" .env` became a write to `.env` instead of a read, so a `Read(.env)` deny did not apply while a bare `Write` deny refused the command.
- fd plumbing counted as a file: `2>&1` became a write to a file named `&1`, and `> /dev/null` a write to `/dev/null`.
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
- Modelling `[[ … ]]` tests, `(( … ))` and `$(( … ))` arithmetic, `${…}` expansions and `#` comments. Their `<` and `>` still read as redirections. Telling a comparison from a redirection there means seeing into the command and process substitutions these regions can hold, or a real redirection inside one is lost with the comparison: `[[ -n $(printf X > p.txt) ]]` writes `p.txt`. That needs a parser, so it belongs with moving the extraction onto the tree-sitter AST that `shellAstParser.ts` already builds.

## Design

### Tokenizer

Each character of a word records how it was written: unquoted, inside double quotes, or literal (single quotes or a backslash escape). The text after quote removal is the same as before, so every command handler sees the same words. Words split at unquoted spaces and tabs only: `#`, `${…}`, `$((…))` and `[[` get no special treatment (see Non-goals). A `(` at the start of a word and a `)` or `&` at its end are dropped as shell syntax only when unquoted: `>"notes)"` writes `notes)`, and `cat 'b&'` reads `b&`. An empty quoted word (`''`) is still a word, so `sudo -p '' cat .env` gives `-p` an empty value.

### Redirections

A word is split at its unquoted `<` and `>` characters. A run of unquoted digits or `&` before the first operator is its fd; quoted, as in `"2">f`, it is an argument. Each piece is matched against one pattern covering `>`, `>>`, `>|`, `>&`, `<`, `<&`, `<>`, `<<`, `<<-` and `<<<`. A quoted character ends the operator, so `>"&1"` writes a file named `&1` and `>"|"x` writes `|x`. When the target is not glued to the operator, it is the next word, which is split the same way: its part before any operator is the target and the rest are further redirections, so `printf X > a>p.txt` writes `a` and then `p.txt`. Shell syntax glued to the end of the word in front is dropped, as for any word, so `cat .env&>f` and `(cat .env)>f` read `.env`.

- `<` and `<&` read, `<>` reads and writes, the others write.
- `>&N`, `>&-` and `N<&M-` duplicate or close fds and touch no file. After an unquoted `-` glued to the operator, bash closes the fd and passes the rest of the word to the command, so `rm >&-notes.txt` removes `notes.txt`: the rest is an argument, and the whole word also stays a file operation (`&-notes.txt`), since only the command knows what that argument is. A `$` or backtick word glued after `>&` or `<&` may expand to a descriptor or a file, so it is checked as the literal `&word`. A quoted leading `-` is part of a file name: `>&"-x"` writes `-x`. These are the rules #15681 gave main's tokenizer. The word after `>&` or `<&` reads the same with or without blanks: `rm >& -notes.txt` removes `notes.txt` too.
- A target that another operator follows drops a bare `)` or `&` before it: `>a&>b` writes `a`, since the `&` belongs to `&>`.
- Redirections on `cd`, `pushd` and `popd` count as well, from the directory the command runs in: `cd . > out.txt` truncates `out.txt`.
- Heredocs and here-strings carry data, not file names.
- `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/N` and the `/dev/tcp` and `/dev/udp` sockets are not files.

A process substitution (`<(cmd)`, `>(cmd)`) reads as a redirection whose target is the rest of the word, as on main; its body is not analysed.

### Prefix commands

The words after a prefix command are quoted again before they are parsed a second time, and the inner command is walked like any compound command. A word holding a command substitution passes through as it is, so a redirection inside the substitution still counts. A wrapped `bash -c SCRIPT` (or `sh`, `zsh`) is unwrapped from the words themselves: SCRIPT is exactly the word bash receives, while quoting it again would lose the quotes inside it, since unwrapping peels only the outer pair. Options are read the way getopt reads them: short options group, a value is glued or the next word, a long option takes `--name=value`, and `--` or a bare `-` ends them. sudo's `-h` takes a value only when it is glued (`-hhost`). `env -S STRING` keeps every word after the string, so a `NAME=VALUE` there is an argument: `env -S cat a=b` reads `a=b`. A chain of prefixes (`sudo env -C dir timeout 5 cat .env`) is peeled in a loop, so a long one does not recurse, and the command it runs is analysed once. `env -C DIR` runs the command in DIR. `env -S STRING` splits STRING into more words for env, so they are analysed as env runs them; quoting the words again would otherwise keep `env -S 'cat .env'` as one word that names no command.

### Compound splitting

`>|` is a redirection, so the splitter no longer cuts at its `|`. The `>` must be shell syntax: after a quoted or escaped `>`, as in `echo \>| cat .env`, the `|` is still a pipe.

## Risks

- More reads and writes are reported, so users with file rules may see a prompt or denial where none appeared before. Each one is an access the command really performs, except in the regions listed next.
- Tests, arithmetic, expansions and comments are not modelled, so a spaced comparison there still reads as a redirection, as on main (`[[ a > b ]]` writes `b`). A comparison glued between two words (`$((a>b))`, `(( n>max ))`) now reads as one too, as a glued operator does anywhere else, where main read the whole word as text. Either can add a prompt, or a denial in headless mode, where writes are denied unless allowed; neither hides an access.
- The tokenizer still does not model every bash construct (substitution bodies, here-doc contents). Those keep their previous behaviour.

## Validation

- Unit tests for each redirection form, the non-file targets, quoting, prefix commands and the `>|` split, and for redirections inside tests, arithmetic, expansions and comments, including the substitutions they hold.
- Permission-level tests: a `Bash(*)` allow rule does not outrank `Edit(p.txt)` or `Read(.env)` denies through these forms, and fd plumbing is not a write under a bare `Write` deny.
- A differential run against current main (with #15681) on 9,933 commands: every string in both versions' permission tests, the probes from this PR's reviews and from #15600, and a generated grid of commands, prefixes, redirection forms, targets and wrappers. 2,085 commands report less than main, and each operation they lose is one main gets wrong: a path that still holds a redirection operator (`0<.env`, `a>p.txt`), a device, the wrong kind of access (`cat 3> p.txt` writes `p.txt` rather than reading it), a here-string's data, a spelling bash rejects as a syntax error, a duplicate, or a quoted operator or parenthesis main read as syntax. Every file whose name holds a quoted `<` or `>` that main reports is still reported. 2,988 commands report more; apart from glued comparisons such as `$((a>b))`, each is an access the command performs.
- A second pass generated about 100,000 commands and checked them against bash's own parse (`declare -f`), compared prefixed and plain forms of the same command, and fed in 150,000 random strings. It found no access main reports that this change loses, other than `env -S` followed by a `NAME=VALUE` argument, which is fixed, and nothing that throws or slows down past main.
- The flow in `.qwen/e2e-tests/2026-10-13-shell-redirect-permissions.md`, run headless against the released `qwen` 0.24.6 and this change. All eight cases flipped as expected: the six redirections that read `.env` or wrote `protected.txt` before are now denied, and the two fd-plumbing commands a bare `Write` deny refused before now run.
