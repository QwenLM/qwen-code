@echo off
REM === Test 3: Inline echo commands (no file encoding issue) ===
REM
REM This tests what happens when qwen-code runs an inline command like
REM   cmd /c echo 你好世界
REM rather than writing a .bat file.
REM
REM On Windows, spawn() uses CreateProcessW (UTF-16), so the command
REM string itself is passed correctly. The OUTPUT from cmd.exe will be
REM in the system codepage (GBK).
REM
REM Run this .bat from cmd.exe to see the baseline behavior,
REM then compare with step 2 below.

echo Current codepage:
chcp
echo.

echo --- Step 1: Direct echo in this .bat file (may be garbled since file is UTF-8) ---
echo 你好世界
echo.

echo --- Step 2: Now run these commands MANUALLY in cmd.exe ---
echo     cmd /c echo 你好世界
echo     cmd /c echo 测试中文
echo.
echo If Step 1 is garbled but Step 2 (typed manually) shows correctly,
echo it confirms the issue is file encoding, not command passing.
echo.

echo --- Step 3: Testing cmd /c with inline Chinese ---
cmd /c echo 内联命令测试
echo.
echo Step 3 output depends on how this .bat file's bytes are interpreted.

pause
