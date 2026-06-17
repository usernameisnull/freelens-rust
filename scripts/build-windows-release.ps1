Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

Write-Host "==> Building frontend"
npm --prefix frontend run build

Write-Host "==> Running Rust tests"
cargo test --workspace

Write-Host "==> Building Tauri Windows package"
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue) -and -not (cargo --list | Select-String -SimpleMatch "tauri")) {
  throw "cargo-tauri is not installed. Install it with: cargo install tauri-cli --version '^2'"
}

cargo tauri build

Write-Host "==> Release artifacts"
Get-ChildItem -Path "target\release\bundle" -Recurse -File | Select-Object FullName, Length
