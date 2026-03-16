# Test PowerShell encoding behavior on non-UTF-8 Windows systems

Write-Host "=== PowerShell Encoding Info ==="
Write-Host "OutputEncoding: $([Console]::OutputEncoding.EncodingName) (CP $([Console]::OutputEncoding.CodePage))"
Write-Host "InputEncoding:  $([Console]::InputEncoding.EncodingName) (CP $([Console]::InputEncoding.CodePage))"
Write-Host "PSDefaultParameterValues: $($PSDefaultParameterValues['*:Encoding'])"
Write-Host ""

Write-Host "=== CJK Output (default encoding) ==="
Write-Host "你好世界 - Hello World"
Write-Host "测试中文输出"
Write-Host ""

Write-Host "=== After forcing UTF-8 output ==="
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host "OutputEncoding: $([Console]::OutputEncoding.EncodingName) (CP $([Console]::OutputEncoding.CodePage))"
Write-Host "你好世界 - Hello World (UTF-8 mode)"
Write-Host "测试中文输出 (UTF-8 mode)"
