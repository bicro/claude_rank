fn main() {
    // XOR key for obfuscation (16 bytes)
    const XOR_KEY: [u8; 16] = [
        0x4f, 0x72, 0x61, 0x6e, 0x67, 0x65, 0x50, 0x69,
        0x6e, 0x65, 0x61, 0x70, 0x70, 0x6c, 0x65, 0x21,
    ];

    // Check if OPENROUTER_API_KEY environment variable is set at build time
    if let Ok(api_key) = std::env::var("OPENROUTER_API_KEY") {
        if !api_key.is_empty() {
            // XOR obfuscate the key
            let obfuscated: Vec<u8> = api_key
                .bytes()
                .enumerate()
                .map(|(i, b)| b ^ XOR_KEY[i % XOR_KEY.len()])
                .collect();

            // Hex-encode the obfuscated bytes
            let hex_encoded: String = obfuscated
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();

            // Pass to rustc as environment variables
            println!("cargo:rustc-env=OBFUSCATED_API_KEY={}", hex_encoded);
            println!("cargo:rustc-env=HAS_BUILTIN_KEY=1");
        } else {
            println!("cargo:rustc-env=OBFUSCATED_API_KEY=");
            println!("cargo:rustc-env=HAS_BUILTIN_KEY=0");
        }
    } else {
        println!("cargo:rustc-env=OBFUSCATED_API_KEY=");
        println!("cargo:rustc-env=HAS_BUILTIN_KEY=0");
    }

    // Re-run build script if OPENROUTER_API_KEY changes
    println!("cargo:rerun-if-env-changed=OPENROUTER_API_KEY");

    tauri_build::build()
}
