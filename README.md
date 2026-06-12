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
