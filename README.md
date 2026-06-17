# Freelens Rust prototype

This repository contains the first runnable migration slice described in
`REWRITE_PLAN.md`: a Tauri 2 shell, a versioned Rust IPC contract, and a small
React renderer that talks through a transport abstraction.

## Prerequisites

- Windows 10 or later with WebView2
- Rust stable with the MSVC target
- Node.js 20 or later

## Run

```powershell
npm --prefix frontend install
npm --prefix frontend run build
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo run -p freelens-app
```

To run only the renderer with its built-in mock backend:

```powershell
cd frontend
npm install
npm run dev
```

## Verify

```powershell
cargo test --workspace
cd frontend
npm run build
```

## Build The Debug Executable

Run both commands from the repository root whenever the frontend or Rust code changes:

```powershell
npm --prefix frontend run build
cargo build -p freelens-app
```

The executable is generated at `target\debug\freelens-app.exe`.

## Build The Windows Package

The release package path is documented in `docs\RELEASE_AND_ELECTRON_REMOVAL.md`.

```powershell
.\scripts\build-windows-release.ps1
```

The script expects `cargo tauri build` to be available. If it is missing:

```powershell
cargo install tauri-cli --version '^2'
```
