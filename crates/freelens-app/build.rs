fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let icon_path = manifest_dir.join("icons").join("freelens.ico");

    println!("cargo:rerun-if-changed={}", icon_path.display());

    let windows = tauri_build::WindowsAttributes::new().window_icon_path(&icon_path);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to build Tauri application resources");
}
