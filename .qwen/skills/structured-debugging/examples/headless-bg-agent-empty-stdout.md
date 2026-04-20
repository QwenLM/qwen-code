# Worked example: headless run prints empty stdout in zsh TTY

A short qwen-code case to illustrate two failure modes from `SKILL.md`:
_reproduction contradiction is data_, and _instrument the data flow, not
just the code path_.

## The bug

User: `npm run dev -- -p "..."` in zsh prints nothing. Process exits clean,
`~/.qwen/logs` shows the model returned proper text. Stdout was empty.

Cause: `JsonOutputAdapter.emitResult` wrote `resultMessage.result` without
a trailing `\n`. zsh's `PROMPT_SP` (powerlevel10k, agnoster, …) detects
the missing newline and emits `\r\033[K` before drawing the next prompt,
erasing the line. Pipe-captured stdout has no `PROMPT_SP`, so the bug is
invisible there.

Fix: append `\n` to the write.

## What made the case instructive

Every reproduction attempt from a debugging environment that captures
stdout (Cursor's Shell tool, `out=$(...)`, `tee`, file redirect) **passed**.
14/14 success against the user's 0/N. Same SHA, same machine, same
command. The only variable was: pipe stdout vs TTY stdout.

That contradiction was the entire investigation. Once it was named, the
fix was one line.

## Lessons mapped to SKILL.md

- **Reproduction contradiction is data, not user error.** When your run
  succeeds and the user's fails on identical state, the _difference
  between the two environments_ is where the bug lives. Catalogue what
  differs (TTY vs pipe, terminal emulator, shell, locale, env vars,
  prior state) before forming any hypothesis. Reframing the user's
  report ("they must be on stale code") burns rounds and credibility.

- **Ask the one disambiguating question first.** "Does it hang or exit
  cleanly?" would have falsified the most tempting wrong hypothesis here
  (the recently-fixed drain-loop hang) on turn one. For any "no output"
  report, that question is free and prunes half the hypothesis space.

- **Instrument the data flow, not just the code path.** Tracing whether
  `write` was called showed the happy path firing every time and resolved
  nothing. The breakthrough was logging the _return value_ of
  `process.stdout.write` together with `process.stdout.isTTY`. Code-path
  traces tell you what ran; data traces tell you what it ran on.

- **Pipe ≠ TTY.** A passing pipe-captured run does not prove a TTY user
  sees the same output. Shell prompts can post-process trailing-newline-
  less writes; terminals can swallow control sequences; pipes do
  neither. When debugging interactive-shell symptoms, get evidence from
  the user's actual terminal at least once.

## Reference

Fix commit: qwen-code `feadf052f` —
`fix(cli): append newline to text-mode emitResult so zsh PROMPT_SP doesn't erase the line`
