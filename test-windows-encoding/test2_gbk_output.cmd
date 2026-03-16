@echo off
REM This file is ASCII-only so it runs on any codepage.
REM It uses cmd built-ins that produce output in the system codepage.

echo === System codepage info ===
chcp
echo.

echo === Directory listing (system codepage output) ===
REM Create a temp dir with CJK name, list it, clean up
mkdir "%TEMP%\测试目录_qwen" 2>nul
echo test > "%TEMP%\测试目录_qwen\数据文件.txt"
dir "%TEMP%\测试目录_qwen"
rmdir /s /q "%TEMP%\测试目录_qwen"
echo.

echo === Environment variable with CJK ===
set QWEN_TEST=中文环境变量值
echo %QWEN_TEST%
set QWEN_TEST=

echo === Done ===
