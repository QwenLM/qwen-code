# Windows Encoding Test Plan

Run these tests on a Windows machine with a **non-UTF-8 system codepage**
(e.g., GBK/CP936). All test scripts are in this directory.

## Setup

Copy this entire `test-windows-encoding/` folder to the Windows machine.
Verify your system codepage:

```cmd
chcp
```

Expected: `Active code page: 936` (or another non-UTF-8 codepage).

---

## Test 1: GBK .bat file without chcp (Row 4)

**What it tests:** A `.bat` file saved in GBK encoding — does it run and
display correctly on a GBK system without any `chcp`?

**Script:** `test1_gbk_native.cmd`

**How to create it:** The file must be saved as GBK (not UTF-8). Open
Notepad, paste the content from `test1_gbk_native.utf8.txt`, then
**Save As → Encoding: ANSI** → `test1_gbk_native.cmd`.

**Run:**

```cmd
cmd /c test1_gbk_native.cmd
```

**Expected:** Chinese characters display correctly (native codepage match).

---

## Test 2: UTF-8 output detection — GBK program output

**What it tests:** When a GBK-native command produces CJK output (no chcp),
does qwen-code's `getCachedEncodingForBuffer()` correctly detect it as
non-UTF-8 and decode it?

**Script:** `test2_gbk_output.cmd`

**Run (two ways):**

```cmd
REM Direct — should show correct GBK output
cmd /c test2_gbk_output.cmd

REM Through qwen-code shell tool — check if output is garbled or correct
```

Ask qwen-code to: `run test2_gbk_output.cmd` (no chcp hint).

**Expected in qwen-code:** If `isValidUtf8()` rejects the GBK bytes and
chardet identifies GBK, the output should be decoded correctly. If chardet
fails, it falls back to system encoding (should also be correct on a GBK
system). **This is the key test for output detection.**

---

## Test 3: PowerShell encoding

**What it tests:** Does PowerShell output CJK correctly? Does qwen-code
decode it?

**Script:** `test3_powershell.ps1`

**Run:**

```powershell
powershell -ExecutionPolicy Bypass -File test3_powershell.ps1
```

Also ask qwen-code to run it.

**Expected:** PowerShell on modern Windows defaults to UTF-8 for many
cmdlets, but `[Console]::OutputEncoding` may still be the system codepage.
The test prints both the encoding and CJK text so you can see what happens.

---

## Test 4: File round-trip (write → edit → verify)

**What it tests:** qwen-code writes a UTF-8 `.cmd` file, then edits it.
Does the file maintain UTF-8 encoding and CRLF line endings after the edit?

**How to test:**

1. Ask qwen-code: "Write a file called `test4_roundtrip.cmd` with this content:
   `@echo off` / `echo 测试文件` / `echo 编辑成功`"
2. Ask qwen-code: "Edit `test4_roundtrip.cmd` and change `测试文件` to `测试完成`"
3. Verify manually:

   ```cmd
   REM Check line endings (should see \r\n)
   powershell -Command "Format-Hex test4_roundtrip.cmd | Select-Object -First 5"

   REM Check encoding (should be UTF-8 without BOM)
   powershell -Command "[System.IO.File]::ReadAllBytes('test4_roundtrip.cmd') | Select-Object -First 10"
   ```

4. Run: `chcp 65001 && cmd /c test4_roundtrip.cmd`

**Expected:** File stays UTF-8, CRLF preserved, content updated correctly.

---

## Test 5: Edit a GBK file (preserve encoding)

**What it tests:** qwen-code opens an existing GBK-encoded file, edits it,
and the file stays GBK (not converted to UTF-8).

**Setup:** Create a GBK file using Notepad (Save As → ANSI):

```
@echo off
echo 原始内容
echo 第二行
```

Save as `test5_gbk_edit.cmd`.

**How to test:**

1. Ask qwen-code: "Edit `test5_gbk_edit.cmd` and change `原始内容` to `修改内容`"
2. Verify encoding stayed GBK:
   ```cmd
   powershell -Command "[System.IO.File]::ReadAllBytes('test5_gbk_edit.cmd') | Select-Object -First 20"
   ```
   GBK `修改` = `D0 DE B8 C4`, not UTF-8 `E4 BF AE E6 94 B9`.
3. Run without chcp: `cmd /c test5_gbk_edit.cmd`

**Expected:** File stays GBK, runs correctly without chcp.

---

## Test 6: PTY path — chcp inside command

**What it tests:** The critical PTY question from FINDINGS.md §2.3. When
ConPTY is used, does `chcp 65001 && script.cmd` produce correct output,
or does ConPTY's pipe encoding (set at creation time) cause garbling?

**How to test:**
Ask qwen-code to run (ensure it uses PTY, not child_process):

```
chcp 65001 && cmd /c test-windows-encoding\progress.cmd
```

Then compare with child_process fallback (if possible, or just note
whether qwen-code used PTY or child_process in the tool call).

**Expected if ConPTY respects chcp:** Correct output.
**Expected if ConPTY ignores chcp:** Garbled — would mean we need
the PTY `encoding: 'utf-8'` option back.

---

## Test 7: CJK in directory/file names

**What it tests:** Commands that produce CJK output from the filesystem
(not from our scripts).

**Setup:**

```cmd
mkdir 测试目录
echo test > 测试目录\测试文件.txt
```

**Run:**

```cmd
dir 测试目录
```

Also ask qwen-code to: `list files in 测试目录`

**Expected:** qwen-code should display the CJK filenames correctly. This
output is in the system codepage (GBK), so `getCachedEncodingForBuffer()`
must detect it as non-UTF-8.

---

## Test 8: Large CJK output (encoding detection at scale)

**What it tests:** Encoding detection uses only the first chunk. If the
first chunk is ASCII-only and subsequent chunks contain GBK, does the
decoder still work?

**Script:** `test8_large_output.cmd`

**Run through qwen-code.**

**Expected:** The ASCII header should display fine. The CJK block should
also display correctly IF encoding detection/fallback handles the case
where the first chunk was valid UTF-8 (because ASCII is valid UTF-8) but
later chunks contain GBK bytes. This is a potential edge case.

---

## Results Template

| #   | Test                   | Direct cmd | qwen-code (child_process) | qwen-code (PTY) | Notes |
| --- | ---------------------- | ---------- | ------------------------- | --------------- | ----- |
| 1   | GBK native .bat        |            |                           |                 |       |
| 2   | GBK output detection   |            |                           |                 |       |
| 3   | PowerShell encoding    |            |                           |                 |       |
| 4   | File round-trip        |            |                           |                 |       |
| 5   | GBK file edit          |            |                           |                 |       |
| 6   | PTY + chcp 65001       |            |                           |                 |       |
| 7   | CJK directory names    |            |                           |                 |       |
| 8   | Large output, late CJK |            |                           |                 |       |
