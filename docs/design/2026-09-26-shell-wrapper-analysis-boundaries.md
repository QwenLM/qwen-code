# Shell wrapper analysis boundaries

Status: Design note for PR #12339.

## Problem and scope

A `bash -c` script word can contain adjacent quoted and unquoted runs. The old monitor normalization rebuilt that word for spawning and joined the dequoted script with outer-shell text for safety checks. Rebuilding changed escaped double quotes; joining let an unmatched quote or comment in one context conceal a command in the other. Bash word separators are only space, tab, and newline; lone CR, VT, FF, and NBSP remain part of a word. This change is limited to wrapper parsing and its safety consumers, without introducing a separate shell lexer.

## Contract and decisions

- `analysisCommand` is the dequoted `-c` script word. Unquoted shell metacharacters terminate that word; positional `-c` arguments are not part of the script.
- `safetyCommands` contains independently parsed views of the combined command, the dequoted script, and executable outer-shell suffix commands. Permission, read-only, auto-mode, and plan-mode checks use the most restrictive outcome across views. A quote in one view cannot swallow another view.
- `spawnCommand` preserves the original input when no final bare background operator is removed. Monitor's existing lifecycle rule still removes a final bare `&`; that established exception remains intentional.
- `stripShellWrapper` exposes dequoted script content and outer-shell syntax while retaining the historical behavior that plain positional arguments are not executable script text.
- Wrapper tokenization uses Bash separators and unquoted metacharacter boundaries. Escaped double quotes remain unchanged in the raw spawn string. The shell background gate checks both raw and dequoted views.

## Validation and risks

Regression tests cover quote concatenation, escaped double quotes, hidden `rm` and substitution, literal quotes and comments before an outer suffix, CR/VT/FF/NBSP glue, fallback command roots, and managed-background `&`. The primary risk is conservative safety classification of ambiguous shell syntax; no view may independently grant permission over a deny from another view. Verification includes focused shell/security tests, typecheck, build, lint, formatting, and `git diff --check`.
