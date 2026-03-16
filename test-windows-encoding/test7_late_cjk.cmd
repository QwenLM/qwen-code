@echo off
REM Pure ASCII file - no CJK characters in this script.
REM Produces ASCII output first, then GBK output via dir command.

echo === ASCII BLOCK ===
for /L %%i in (1,1,20) do echo Line %%i: ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789
echo === END ASCII BLOCK ===
echo.
echo === SYSTEM CODEPAGE OUTPUT ===
dir C:\encoding_test
echo === DONE ===
