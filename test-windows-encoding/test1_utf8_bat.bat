@echo off
REM === Test 1: UTF-8 bat file with Chinese (BEFORE fix) ===
REM This file is UTF-8. On GBK system, Chinese chars below will break cmd.exe.
REM Run this BEFORE applying the chcp 65001 fix to confirm the bug.

echo Current codepage:
chcp
echo.
echo The next line has Chinese chars encoded as UTF-8.
echo If codepage is 936, this will be garbled or cause errors:
echo 你好世界
pause
