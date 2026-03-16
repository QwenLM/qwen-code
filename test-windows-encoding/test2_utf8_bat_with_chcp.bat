@echo off
REM === Test 2: UTF-8 bat file with chcp 65001 (AFTER fix) ===
REM This simulates what qwen-code will do after the fix:
REM switch to UTF-8 codepage before running the command.

echo Current codepage:
chcp
echo.

echo Switching to UTF-8 codepage...
chcp 65001 >nul

echo Now the Chinese text should display correctly:
echo 你好世界
echo 测试中文输出
echo Mixed: Hello世界Test测试
echo.

echo Restoring original codepage...
chcp 936 >nul
pause
