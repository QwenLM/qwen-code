@echo off
REM === Test 1: UTF-8 .bat file with Chinese characters ===
REM
REM This file is saved as UTF-8 (what qwen-code's write-file tool does).
REM On a GBK (CP936) Windows system, cmd.exe reads it using GBK encoding.
REM The Chinese characters below will appear GARBLED.
REM
REM EXPECTED: Garbled output on GBK system

echo Current codepage:
chcp
echo.
echo --- The following lines should show Chinese, but will be garbled ---
echo 你好世界
echo 测试中文输出
echo 一二三四五六七八九十
echo Mixed: Hello世界Test测试
echo.
echo If the above lines are garbled, this confirms the bug:
echo qwen-code writes .bat files as UTF-8, but cmd.exe reads them as GBK.
pause
