@echo off
REM === Test 3: Simulate qwen-code shell execution (BEFORE vs AFTER fix) ===
REM
REM Uses PowerShell to create UTF-8 scripts, then runs them in ways that
REM simulate the before/after behavior of the fix.
REM
REM The fix: only add "chcp 65001" when the command contains non-ASCII chars.
REM   - "echo hello" -> no chcp (pure ASCII, safe for legacy GBK scripts)
REM   - "echo ni hao shi jie" with Chinese -> chcp 65001 prefix added
REM
REM This file has NO Chinese chars so it parses correctly on any codepage.

echo === Test 3: Simulating qwen-code write-file then execute ===
echo.
echo Current codepage:
chcp
echo.

REM --- Create UTF-8 scripts with Chinese content via PowerShell ---
echo Creating test scripts via PowerShell...
powershell -NoProfile -Command "[IO.File]::WriteAllText('%TEMP%\qwen_utf8_test.bat', \"@echo off`r`necho `u{4F60}`u{597D}`u{4E16}`u{754C}`r`necho `u{6D4B}`u{8BD5}`u{4E2D}`u{6587}`u{8F93}`u{51FA}`r`n\", [Text.UTF8Encoding]::new($false))"
echo.

REM --- Case A: Run WITHOUT chcp (current broken behavior) ---
echo === Case A: UTF-8 script, NO chcp (current qwen-code behavior) ===
echo EXPECTED: Garbled or errors
echo ---
call "%TEMP%\qwen_utf8_test.bat"
echo ---
echo.

REM --- Case B: Run WITH chcp 65001 (the fix, for non-ASCII commands) ---
echo === Case B: UTF-8 script, WITH chcp 65001 (the fix) ===
echo EXPECTED: Correct Chinese output
echo ---
cmd /d /s /c "chcp 65001 >nul && call "%TEMP%\qwen_utf8_test.bat""
echo ---
echo.

REM --- Case C: ASCII-only command calling a legacy GBK script ---
REM   The fix should NOT add chcp for this case.
echo Creating a GBK-encoded legacy script...
powershell -NoProfile -Command "$enc = [Text.Encoding]::GetEncoding('gb2312'); [IO.File]::WriteAllText('%TEMP%\qwen_gbk_legacy.bat', \"@echo off`r`necho `u{4F60}`u{597D}`u{4E16}`u{754C}`r`necho `u{6D4B}`u{8BD5}`u{4E2D}`u{6587}`u{8F93}`u{51FA}`r`n\", $enc)"

echo === Case C: GBK legacy script, NO chcp (command is ASCII-only) ===
echo EXPECTED: Correct Chinese output (GBK script on GBK system)
echo ---
call "%TEMP%\qwen_gbk_legacy.bat"
echo ---
echo.

echo === Case D: GBK legacy script, WITH chcp 65001 (would be wrong) ===
echo EXPECTED: Garbled (chcp 65001 misreads GBK bytes as UTF-8)
echo ---
cmd /d /s /c "chcp 65001 >nul && call "%TEMP%\qwen_gbk_legacy.bat""
echo ---
echo.

REM --- Cleanup ---
del "%TEMP%\qwen_utf8_test.bat" 2>nul
del "%TEMP%\qwen_gbk_legacy.bat" 2>nul

echo === Summary ===
echo Case A (UTF-8, no chcp):     GARBLED  - this is the bug
echo Case B (UTF-8, chcp 65001):  CORRECT  - the fix for non-ASCII commands
echo Case C (GBK, no chcp):       CORRECT  - ASCII-only command, no chcp needed
echo Case D (GBK, chcp 65001):    GARBLED  - why we must NOT blindly add chcp
echo.
echo The fix only adds "chcp 65001" when the command contains non-ASCII chars.
echo ASCII-only commands (like "call legacy.bat") are left unchanged.
pause
