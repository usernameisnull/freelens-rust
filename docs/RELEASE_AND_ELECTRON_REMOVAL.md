# Release And Electron Removal

This project is the Tauri/Rust replacement path for the Electron-based Freelens application. Do not remove Electron-only code from the original app until the release gates below pass.

## Windows Release Build

Run from the repository root:

```powershell
.\scripts\build-windows-release.ps1
```

The script performs:

- Frontend production build.
- Rust workspace tests.
- Tauri Windows package build.
- Release artifact listing from `target\release\bundle`.

If `cargo tauri build` is unavailable, install the Tauri CLI:

```powershell
cargo install tauri-cli --version '^2'
```

## Release Gates

- Core Kubernetes browsing works against real kubeconfigs.
- Resource list, watch reconnect, logs, terminal, port-forward, kubectl, create, edit, and delete workflows pass smoke testing.
- Settings and kubeconfig source changes survive app restart.
- NSIS installer installs on a clean Windows machine.
- Cover install keeps existing app data and kubeconfig source settings.
- Uninstall removes application binaries without deleting user kubeconfigs.
- Downgrade behavior is decided and tested before public release.
- WebView2 runtime requirement is documented or handled by installer.

## Electron Removal Gates

- The Tauri app covers the supported workflows in `REWRITE_PLAN.md`.
- Behavior parity checks are documented for the old Electron app and the Tauri app.
- No renderer code path depends on Electron IPC.
- No release script depends on Electron packaging.
- Extension compatibility level is explicitly documented.
- Rollback plan exists for the first Tauri-only release.

## Current Status

- Tauri bundling is enabled with the NSIS target.
- The old Electron application has not been removed from the upstream Freelens repository.
- Code signing, auto-update, tray/menu integration, and extension compatibility remain separate follow-up work.
