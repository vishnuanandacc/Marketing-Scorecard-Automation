$Dev = $false
foreach ($arg in $args) {
    if ($arg -eq "-Dev") {
        $Dev = $true
    }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodeArgs = if ($Dev) { @("--watch", "dev.mjs") } else { @("server.js") }

Set-Location $projectRoot

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node @nodeArgs
    exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $bundledNode) {
    & $bundledNode @nodeArgs
    exit $LASTEXITCODE
}

Write-Error "Node.js 22 or newer is required. Install Node.js or run this from Codex with the bundled runtime available."
exit 1
