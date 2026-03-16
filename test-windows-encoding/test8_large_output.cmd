@echo off
REM Test: large ASCII prefix followed by CJK content.
REM Purpose: encoding detection uses the first chunk. If the first chunk
REM is pure ASCII (valid UTF-8), the decoder is set to UTF-8. But later
REM output may contain GBK bytes from system-codepage commands.
REM This tests whether that late GBK content gets decoded correctly.

echo === BEGIN ASCII BLOCK ===
for /L %%i in (1,1,50) do (
    echo Line %%i: The quick brown fox jumps over the lazy dog. ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789
)
echo === END ASCII BLOCK ===
echo.

echo === BEGIN CJK BLOCK (system codepage) ===
REM These CJK chars are in the .cmd file itself.
REM If the file is UTF-8 but system is GBK, these will be garbled.
REM If the file is run with chcp 65001, they should be correct.
echo 第一行中文内容：编码检测测试
echo 第二行中文内容：这些字符在ASCII块之后输出
echo 第三行中文内容：如果前面的ASCII导致检测为UTF-8
echo 第四行中文内容：那么这些GBK字节会被错误解码
echo === END CJK BLOCK ===

echo.
echo === System-generated CJK output ===
mkdir "%TEMP%\编码测试_qwen" 2>nul
echo data > "%TEMP%\编码测试_qwen\报告.txt"
dir "%TEMP%\编码测试_qwen"
rmdir /s /q "%TEMP%\编码测试_qwen"

echo === DONE ===
