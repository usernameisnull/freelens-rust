fn main() {
    ensure_window_icon();

    let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let icon_path = out_dir.join("prototype.ico");

    std::fs::write(&icon_path, prototype_icon()).expect("failed to write prototype icon");

    let windows = tauri_build::WindowsAttributes::new().window_icon_path(icon_path);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to build Tauri application resources");
}

fn ensure_window_icon() {
    let manifest_dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let icon_dir = manifest_dir.join("icons");
    let icon_path = icon_dir.join("icon.png");

    std::fs::create_dir_all(icon_dir).expect("failed to create icon directory");
    std::fs::write(
        icon_path,
        [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 29, 99, 248, 207, 192,
            240, 31, 0, 5, 128, 2, 63, 73, 194, 247, 89, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
            130,
        ],
    )
    .expect("failed to write prototype window icon");
}

fn prototype_icon() -> Vec<u8> {
    let mut icon = vec![
        0, 0, 1, 0, 1, 0, // ICO header
        1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0, // directory entry
        40, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 32, 0, // bitmap header
        0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    icon.extend_from_slice(&[0xb5, 0xd1, 0x58, 0xff]); // BGRA pixel
    icon.extend_from_slice(&[0, 0, 0, 0]); // transparency mask
    icon
}
