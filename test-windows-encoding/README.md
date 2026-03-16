# Windows GBK Encoding Reproduction Tests

Reproduces encoding issues when running qwen-code on Windows with codepage 936 (GBK).

## Prerequisites

- Windows system with default codepage CP936 (GBK)
- Verify: run `chcp` in cmd.exe — should show `Active code page: 936`

## Tests

### Test 1: `test1_utf8_bat.bat` — The bug

A UTF-8 `.bat` file containing Chinese characters. On a GBK system, cmd.exe
misinterprets the bytes, breaking the entire script.

**Expected:** Garbled output or command errors.

### Test 2: `test2_utf8_bat_with_chcp.bat` — The fix

Same UTF-8 file, but with `chcp 65001` before the Chinese echo lines.
After switching codepage, Chinese should display correctly.

**Expected:** Correct Chinese output after `chcp 65001`.

### Test 3: `test3_simulate_qwen.bat` — Full simulation (most important)

Uses PowerShell to create UTF-8 `.bat` scripts (exactly what qwen-code's
write-file tool does), then runs each one two ways:

- **Without chcp** (current broken behavior)
- **With `chcp 65001` prefix** (the fix)

This file itself contains NO Chinese characters, so it parses correctly
on any codepage.

**Expected:**
| Scenario | Result |
|---|---|
| 2A: UTF-8 script, no chcp | Garbled or broken |
| 2B: UTF-8 script, with chcp 65001 | Correct Chinese |
| 3A: Inline command, no chcp | Garbled or broken |
| 3B: Inline command, with chcp 65001 | Correct Chinese |

## How to run

1. Copy this folder to a Windows machine with GBK codepage
2. Open cmd.exe, run `chcp` to verify codepage is 936
3. Run test3 first — it is the most important and self-contained
4. Run test1 and test2 to see the before/after difference

## Code changes

The fix is in `packages/core/src/services/shellExecutionService.ts`:

- New method `wrapCommandForWindowsEncoding()` prefixes commands with
  `chcp 65001 >nul &&` when on Windows with a non-UTF-8 codepage.

Also fixed in `packages/core/src/utils/systemEncoding.ts`:

- Changed CP936 mapping from `gb2312` to `gbk` (GBK is the correct
  superset encoding for Windows code page 936).
