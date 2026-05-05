$root = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
Set-Location $root
Start-Process "http://localhost:8000"
Write-Host "Starting local server at http://localhost:8000"
python -m http.server 8000
