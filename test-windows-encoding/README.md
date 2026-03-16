# Windows GBK Encoding Reproduction Tests

Reproduces encoding issues when running qwen-code on Windows with codepage 936 (GBK).

## Prerequisites

- Windows system with default codepage CP936 (GBK)
- Verify: run `chcp` in cmd.exe — should show `Active code page: 936`

## Tests

### Test 1: `test1_utf8_bat.bat`

Demonstrates the core bug: this `.bat` file is UTF-8 (what qwen-code's
write-file tool produces). On a GBK system, cmd.exe interprets the bytes
as GBK, so Chinese characters appear garbled.

**Expected:** Garbled Chinese output.

### Test 2: `test2_chcp_workaround.bat`

Same UTF-8 file, but switches to `chcp 65001` before echoing.
Shows the first line (before chcp) is garbled, and lines after chcp are correct.

**Expected:** First Chinese line garbled, rest correct.

### Test 3: `test3_inline_echo.bat`

Tests inline `cmd /c echo ...` commands. Since this `.bat` file itself is
UTF-8, all echo output will be garbled. But if you type the same commands
**manually** in cmd.exe, they should display correctly — proving the issue
is file encoding, not command passing.

**Expected:** Garbled in script, correct when typed manually.

### Test 4: `test4_output_decoding.bat`

Manual test instructions for verifying qwen-code's output decoding.
Type commands manually in cmd.exe while qwen-code is capturing output,
and check if qwen-code displays them correctly.

### Test 5: `test5_simulate_writeFile.bat` (most comprehensive)

Uses PowerShell to create `.bat` files in different encodings, then runs
each one. Directly simulates qwen-code's write-file → execute flow.

**Expected results:**
| Encoding | Result |
|---|---|
| UTF-8 (no BOM) | Garbled — this is what qwen-code does |
| UTF-8 (with BOM) | May work on Win10+ |
| GBK | Correct |
| UTF-8 + chcp 65001 | Correct |

## How to run

1. Copy this folder to a Windows machine with GBK codepage
2. Open cmd.exe
3. Run `chcp` to verify codepage is 936
4. Run each `.bat` file and observe the output
5. Test 5 is the most important — it directly simulates qwen-code's behavior
