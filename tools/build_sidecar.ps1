param(
    [string]$PythonExe = $env:TUFFT_PYTHON_EXECUTABLE
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $DefaultPython = Join-Path $env:USERPROFILE ".conda\envs\tufft\python.exe"
    if (Test-Path -LiteralPath $DefaultPython) {
        $PythonExe = $DefaultPython
    }
}
if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $PythonExe = "python"
}
$PythonExe = (Get-Command -Name $PythonExe -CommandType Application -ErrorAction Stop).Source

$SidecarDir = Join-Path $ProjectRoot "src-tauri\binaries"
$SidecarExe = Join-Path $SidecarDir "tufft-sidecar\tufft-sidecar.exe"
$TauriSidecarExe = Join-Path $SidecarDir "tufft-sidecar-x86_64-pc-windows-msvc.exe"
$CondaPrefix = Split-Path -Parent $PythonExe
$CondaBin = Join-Path $CondaPrefix "Library\bin"
$EntryPoint = Join-Path $ProjectRoot "python\sidecar\sidecar_entry.py"
$WorkPath = Join-Path $ProjectRoot "build\pyinstaller"

New-Item -ItemType Directory -Path $SidecarDir -Force | Out-Null

$PyInstallerArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--contents-directory", "_internal",
    "--name", "tufft-sidecar",
    "--exclude-module", "cv2",
    "--exclude-module", "PySide6",
    "--exclude-module", "PyQt6",
    "--exclude-module", "IPython",
    "--exclude-module", "notebook",
    "--exclude-module", "matplotlib",
    "--exclude-module", "pandas",
    "--exclude-module", "openpyxl",
    "--exclude-module", "xarray",
    "--exclude-module", "h5py",
    "--exclude-module", "tkinter",
    "--distpath", $SidecarDir,
    "--workpath", $WorkPath,
    "--specpath", $WorkPath
)

$FfmpegExe = & $PythonExe -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if ($LASTEXITCODE -ne 0) {
    throw "Could not resolve imageio-ffmpeg executable (exit code $LASTEXITCODE)."
}
if (-not $FfmpegExe -or -not (Test-Path -LiteralPath $FfmpegExe -PathType Leaf)) {
    throw "imageio-ffmpeg did not return an existing executable: $FfmpegExe"
}
$PyInstallerArgs += @("--add-binary", "${FfmpegExe};.")

$PyInstallerArgs += $EntryPoint

$OriginalPath = $env:PATH
try {
    if (Test-Path -LiteralPath $CondaBin) {
        $env:PATH = "$CondaBin;$OriginalPath"
    }
    & $PythonExe @PyInstallerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }
} finally {
    $env:PATH = $OriginalPath
}
if (-not (Test-Path -LiteralPath $SidecarExe -PathType Leaf)) {
    throw "PyInstaller did not create the sidecar executable: $SidecarExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $SidecarDir "tufft-sidecar\_internal") -PathType Container)) {
    throw "PyInstaller did not create the _internal runtime directory."
}
Copy-Item -LiteralPath $SidecarExe -Destination $TauriSidecarExe -Force

Write-Host "Built sidecar:"
Write-Host "  $SidecarExe"
Write-Host "  $TauriSidecarExe"
