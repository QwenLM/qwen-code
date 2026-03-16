@echo off
REM === Test 5: Simulate qwen-code writing and executing a script ===
REM
REM This simulates the full flow:
REM   1. qwen-code writes a .bat file (UTF-8, what Node.js fs.writeFileSync does)
REM   2. qwen-code executes it via cmd /c
REM   3. The output is captured and decoded
REM
REM We simulate step 1 by creating .bat files with different encodings
REM using PowerShell, then running them.

echo Current codepage:
chcp
echo.

REM --- Create a UTF-8 (no BOM) batch file, like qwen-code does ---
echo Creating UTF-8 batch file (simulating qwen-code's write-file)...
powershell -Command "[System.IO.File]::WriteAllText('%TEMP%\qwen_test_utf8.bat', '@echo off`r`necho 你好世界`r`necho 测试中文输出`r`n', [System.Text.UTF8Encoding]::new($false))"

echo.
echo --- Running UTF-8 .bat (no BOM) ---
echo EXPECTED: Garbled Chinese on GBK system
call "%TEMP%\qwen_test_utf8.bat"
echo.

REM --- Create a UTF-8 with BOM batch file ---
echo Creating UTF-8 BOM batch file...
powershell -Command "[System.IO.File]::WriteAllText('%TEMP%\qwen_test_utf8bom.bat', '@echo off`r`necho 你好世界`r`necho 测试中文输出`r`n', [System.Text.UTF8Encoding]::new($true))"

echo --- Running UTF-8 .bat (with BOM) ---
echo EXPECTED: May work on Windows 10+, garbled on older
call "%TEMP%\qwen_test_utf8bom.bat"
echo.

REM --- Create a GBK batch file ---
echo Creating GBK batch file...
powershell -Command "$enc = [System.Text.Encoding]::GetEncoding('gb2312'); [System.IO.File]::WriteAllText('%TEMP%\qwen_test_gbk.bat', '@echo off`r`necho 你好世界`r`necho 测试中文输出`r`n', $enc)"

echo --- Running GBK .bat ---
echo EXPECTED: Correct Chinese output
call "%TEMP%\qwen_test_gbk.bat"
echo.

REM --- Create a UTF-8 batch file with chcp 65001 ---
echo Creating UTF-8 + chcp 65001 batch file...
powershell -Command "[System.IO.File]::WriteAllText('%TEMP%\qwen_test_chcp.bat', '@echo off`r`nchcp 65001 >nul 2>&1`r`necho 你好世界`r`necho 测试中文输出`r`n', [System.Text.UTF8Encoding]::new($false))"

echo --- Running UTF-8 .bat with chcp 65001 ---
echo EXPECTED: Correct Chinese output (chcp switches to UTF-8 mode)
call "%TEMP%\qwen_test_chcp.bat"
echo.

REM Cleanup
del "%TEMP%\qwen_test_utf8.bat" 2>nul
del "%TEMP%\qwen_test_utf8bom.bat" 2>nul
del "%TEMP%\qwen_test_gbk.bat" 2>nul
del "%TEMP%\qwen_test_chcp.bat" 2>nul

echo === Summary ===
echo UTF-8 (no BOM):    Should be GARBLED
echo UTF-8 (with BOM):  May work on Win10+
echo GBK:               Should be CORRECT
echo UTF-8 + chcp:      Should be CORRECT
echo.
echo The "UTF-8 (no BOM)" case is exactly what qwen-code does today.

pause
