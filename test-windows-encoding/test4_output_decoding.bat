@echo off
REM === Test 4: Output decoding — GBK output vs UTF-8 output ===
REM
REM This tests qwen-code's output decoding logic. When the system codepage
REM is GBK, cmd.exe outputs GBK bytes. qwen-code detects the system
REM encoding via `chcp` and uses TextDecoder to decode.
REM
REM BUT: qwen-code maps CP936 to 'gb2312' instead of 'gbk'.
REM GBK is a superset of GB2312. Characters in GBK but NOT in GB2312
REM may not decode correctly.
REM
REM To test this, type these commands manually in cmd.exe (codepage 936):

echo Current codepage:
chcp
echo.

echo === Manual test instructions ===
echo.
echo 1. Open cmd.exe (make sure codepage is 936)
echo.
echo 2. Type these commands and check if qwen-code displays them correctly:
echo.
echo    echo 你好世界
echo    (common chars - should work with both gb2312 and gbk)
echo.
echo 3. Now run qwen-code and ask it to execute:
echo      echo 你好世界
echo    Check if the output in qwen-code's UI matches.
echo.
echo 4. In qwen-code, ask it to run:
echo      echo 测试中文输出
echo    Check the output.
echo.
echo 5. Test with a command that produces multi-byte output:
echo      dir C:\Users
echo    Check if Chinese folder names display correctly.
echo.
echo 6. Test git with Chinese commit messages:
echo      git log --oneline -5
echo    (if your repo has Chinese commit messages)
echo.

pause
