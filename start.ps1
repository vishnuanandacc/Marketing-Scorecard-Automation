$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

Set-Location $projectRoot

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node server.js
    exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $bundledNode) {
    & $bundledNode server.js
    exit $LASTEXITCODE
}

Write-Error "Node.js 22 or newer is required. Install Node.js or run this from Codex with the bundled runtime available."
exit 1
