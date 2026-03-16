@echo off
REM === Test 3: Simulate qwen-code shell execution (BEFORE vs AFTER fix) ===
REM
REM Uses PowerShell to create UTF-8 scripts with Chinese content, then runs
REM them with and without chcp 65001 to compare.
REM
REM Compatible with PowerShell 5.1 (uses [char] instead of `u{} escapes).
REM This file has NO Chinese chars so it parses correctly on any codepage.

echo === Test 3: Simulating qwen-code write-file then execute ===
echo.
echo Current codepage:
chcp
echo.

REM --- Create UTF-8 script with Chinese content via PowerShell 5.1 ---
echo Creating test scripts via PowerShell...
powershell -NoProfile -Command "$hello=[char]0x4F60+[char]0x597D+[char]0x4E16+[char]0x754C; $test=[char]0x6D4B+[char]0x8BD5+[char]0x4E2D+[char]0x6587+[char]0x8F93+[char]0x51FA; $content=\"@echo off`r`necho $hello`r`necho $test`r`n\"; [IO.File]::WriteAllText([Environment]::ExpandEnvironmentVariables('%%TEMP%%\qwen_utf8_test.bat'), $content, [Text.UTF8Encoding]::new($false))"
echo.

REM --- Case A: Run WITHOUT chcp (current broken behavior) ---
echo === Case A: UTF-8 script, NO chcp (current qwen-code behavior) ===
echo EXPECTED: Garbled or errors
echo ---
call "%TEMP%\qwen_utf8_test.bat"
echo ---
echo.

REM --- Case B: Run WITH chcp 65001 prefix (the fix for non-ASCII commands) ---
echo === Case B: UTF-8 script, WITH chcp 65001 (the fix) ===
echo EXPECTED: Correct Chinese output
echo ---
cmd /d /s /c "chcp 65001 >nul && call "%TEMP%\qwen_utf8_test.bat""
echo ---
echo.

REM --- Create GBK-encoded legacy script ---
echo Creating a GBK-encoded legacy script...
powershell -NoProfile -Command "$hello=[char]0x4F60+[char]0x597D+[char]0x4E16+[char]0x754C; $test=[char]0x6D4B+[char]0x8BD5+[char]0x4E2D+[char]0x6587+[char]0x8F93+[char]0x51FA; $content=\"@echo off`r`necho $hello`r`necho $test`r`n\"; $enc=[Text.Encoding]::GetEncoding('gb2312'); [IO.File]::WriteAllText([Environment]::ExpandEnvironmentVariables('%%TEMP%%\qwen_gbk_legacy.bat'), $content, $enc)"
echo.

REM --- Case C: GBK script, NO chcp (ASCII-only command, should work) ---
echo === Case C: GBK legacy script, NO chcp (command is ASCII-only) ===
echo EXPECTED: Correct Chinese output (GBK script on GBK system)
echo ---
call "%TEMP%\qwen_gbk_legacy.bat"
echo ---
echo.

REM --- Case D: GBK script, WITH chcp 65001 (would be wrong!) ---
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
echo Case A (UTF-8, no chcp):     should be GARBLED  - this is the bug
echo Case B (UTF-8, chcp 65001):  should be CORRECT  - the fix
echo Case C (GBK, no chcp):       should be CORRECT  - no chcp needed
echo Case D (GBK, chcp 65001):    should be GARBLED  - why blind chcp is wrong
echo.
echo The fix only adds "chcp 65001" when the command contains non-ASCII chars.
echo ASCII-only commands (like "call legacy.bat") are left unchanged.
pause
