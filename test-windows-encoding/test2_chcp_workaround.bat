@echo off
REM === Test 2: UTF-8 .bat with chcp 65001 workaround ===
REM
REM Same UTF-8 file, but we switch codepage to 65001 (UTF-8) first.
REM This should fix the garbled output.
REM
REM EXPECTED: Correct Chinese output after chcp 65001

echo Current codepage:
chcp
echo.

echo --- Before chcp 65001 (will be garbled on GBK system) ---
echo 你好世界

echo.
echo Switching to UTF-8 codepage...
chcp 65001 >nul 2>&1
echo.

echo --- After chcp 65001 (should display correctly) ---
echo 你好世界
echo 测试中文输出
echo Mixed: Hello世界Test测试
echo.

REM Restore original codepage
chcp 936 >nul 2>&1
echo Restored codepage to 936.
pause
