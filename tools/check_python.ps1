$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Tests = @(
    "tests.python.test_ex_vivo_pipeline",
    "tests.python.test_preview",
    "tests.python.test_media_preview",
    "tests.python.test_sidecar_config",
    "tests.python.test_sidecar_events",
    "tests.python.test_sidecar_runner"
)

$Candidates = @()
if ($env:TUFFT_PYTHON_EXECUTABLE) {
    $Candidates += $env:TUFFT_PYTHON_EXECUTABLE
}
if ($env:USERPROFILE) {
    $Candidates += (Join-Path $env:USERPROFILE ".conda\envs\tufft\python.exe")
}
$Candidates += "python"

$Python = $null
foreach ($Candidate in $Candidates) {
    if ($Candidate -eq "python") {
        $Resolved = Get-Command python -ErrorAction SilentlyContinue
        if ($Resolved) {
            $Python = $Resolved.Source
            break
        }
    } elseif (Test-Path -LiteralPath $Candidate -PathType Leaf) {
        $Python = $Candidate
        break
    }
}

if (-not $Python) {
    throw "No Python interpreter was found. Set TUFFT_PYTHON_EXECUTABLE to the project environment's python.exe."
}

Write-Host "Using Python: $Python"
& $Python -m unittest @Tests -v
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
