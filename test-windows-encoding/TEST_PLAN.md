# Windows Encoding Test Plan

Run on a Windows machine with **non-UTF-8 system codepage** (e.g., GBK/CP936).

## Setup

Verify your system codepage:

```cmd
chcp
```

Expected: `Active code page: 936` (or another non-UTF-8 codepage).

Create test directories/files from the GBK system itself:

```cmd
mkdir C:\encoding_test
mkdir C:\encoding_test\测试目录
echo 测试内容 > C:\encoding_test\测试目录\报告.txt
echo 第二行 >> C:\encoding_test\测试目录\报告.txt
```

---

## Test 1: ASCII-only command output

**What it tests:** Baseline — ASCII output should always work.

**Ask qwen-code:** `run dir C:\encoding_test`

**Expected:** Directory listing displays correctly. No encoding issues.

---

## Test 2: System-codepage output (GBK)

**What it tests:** Can qwen-code decode GBK output from commands that
produce CJK text natively (not from our scripts)?

**Ask qwen-code:** `run dir C:\encoding_test\测试目录`

**Expected:** CJK filenames (`报告.txt`) display correctly. The `dir`
command outputs in the system codepage (GBK). qwen-code must detect
this and decode it properly.

---

## Test 3: Read a GBK text file

**What it tests:** Can qwen-code read the content of a GBK-encoded file?

**Ask qwen-code:** `run type C:\encoding_test\测试目录\报告.txt`

**Expected:** `测试内容` and `第二行` display correctly. The `type`
command outputs in the system codepage.

---

## Test 4: File round-trip (write UTF-8, edit, verify)

**What it tests:** qwen-code writes a UTF-8 `.cmd` file, then edits it.
Does the file maintain UTF-8 encoding and CRLF line endings?

**Steps:**

1. Ask qwen-code: "Write a file `C:\encoding_test\roundtrip.cmd` with:
   `@echo off` / `echo hello` / `echo world`"
2. Ask qwen-code: "Edit `roundtrip.cmd` and change `hello` to `goodbye`"
3. Run: `cmd /c C:\encoding_test\roundtrip.cmd`

**Expected:** File stays UTF-8 with CRLF. Output shows `goodbye` and `world`.

---

## Test 5: Edit a GBK file (preserve encoding)

**What it tests:** qwen-code edits a GBK-encoded file without corrupting it.

**Setup:** Create a GBK file via Notepad (Save As → ANSI encoding):

```
@echo off
echo 原始内容
echo 第二行
```

Save as `C:\encoding_test\gbk_edit.cmd`.

**Steps:**

1. Ask qwen-code: "Edit `C:\encoding_test\gbk_edit.cmd` and change
   `原始内容` to `修改内容`"
2. Run without chcp: `cmd /c C:\encoding_test\gbk_edit.cmd`

**Expected:** Output shows `修改内容` and `第二行` correctly. File stays GBK.

---

## Test 6: PowerShell CJK output

**What it tests:** Does the `[Console]::OutputEncoding=UTF8` prefix work?

**Ask qwen-code:** `run powershell -Command "Get-ChildItem C:\encoding_test\测试目录"`

**Expected:** CJK filenames display correctly. Our PowerShell prefix
forces UTF-8 output, so this should work regardless of system codepage.

---

## Test 7: Large ASCII output followed by system-codepage CJK

**What it tests:** When early output is ASCII-only and later output
contains GBK, does encoding detection still work?

**Ask qwen-code:** `run the script test7_late_cjk.cmd`

**Script:** `test7_late_cjk.cmd` (ASCII-only file that produces
GBK output via system commands at the end)

**Expected:** ASCII lines display correctly. The final `dir` output
with CJK filenames also displays correctly.

---

## Results Template

| #   | Test                  | child_process | PTY | Notes |
| --- | --------------------- | ------------- | --- | ----- |
| 1   | ASCII output          |               |     |       |
| 2   | GBK dir listing       |               |     |       |
| 3   | GBK file content      |               |     |       |
| 4   | UTF-8 file round-trip |               |     |       |
| 5   | GBK file edit         |               |     |       |
| 6   | PowerShell CJK        |               |     |       |
| 7   | Late CJK after ASCII  |               |     |       |
