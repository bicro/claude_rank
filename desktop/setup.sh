#!/bin/bash
# Oto Desktop - Developer Setup
# Platforms: macOS, Linux, WSL (Windows users: use WSL)

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MISSING=()

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
err() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

prompt() {
    read -p "  Install $1? [y/N] " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

# Detect OS
case "$(uname -s)" in
    Darwin*) OS="macos" ;;
    Linux*)  OS="linux" ;;
    *)       echo "Unsupported OS. Use macOS, Linux, or WSL."; exit 1 ;;
esac
ARCH=$(uname -m | sed 's/arm64/aarch64/;s/x86_64/x86_64/')

# Load installed tool paths (for re-runs after install)
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
[[ -d "$HOME/.bun/bin" ]] && export PATH="$HOME/.bun/bin:$PATH"

echo -e "\n${BLUE}Oto Desktop Setup${NC} ($OS $ARCH)\n"

# Check Rust
if command -v rustc &>/dev/null; then
    ok "Rust $(rustc --version | cut -d' ' -f2)"
else
    err "Rust not installed"
    MISSING+=("rust")
fi

# Check Bun
if command -v bun &>/dev/null; then
    ok "Bun $(bun --version)"
else
    err "Bun not installed"
    MISSING+=("bun")
fi

# Check SQLite
if command -v sqlite3 &>/dev/null; then
    ok "SQLite $(sqlite3 --version | cut -d' ' -f1)"
else
    err "SQLite not installed"
    MISSING+=("sqlite")
fi

# Check jq (required for macOS build scripts)
if [[ $OS == "macos" ]]; then
    if command -v jq &>/dev/null; then
        ok "jq $(jq --version | cut -d'-' -f2)"
    else
        err "jq not installed"
        MISSING+=("jq")
    fi
fi

# Check Linux system deps (required for Tauri)
if [[ $OS == "linux" ]]; then
    if dpkg -s pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-1 gnome-screenshot &>/dev/null 2>&1; then
        ok "Linux system dependencies"
    else
        err "Linux system dependencies not installed"
        MISSING+=("linux-deps")
    fi
fi

# Summary
echo ""
if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo -e "${GREEN}All dependencies installed!${NC}"
    echo ""
    info "Running bun install..."
    bun install
    echo -e "\n${GREEN}Ready!${NC} Run: ${BLUE}bun run dev${NC}"
    exit 0
fi

echo -e "${YELLOW}Missing: ${MISSING[*]}${NC}\n"

# Install missing
for dep in "${MISSING[@]}"; do
    case $dep in
        rust)
            if prompt "Rust"; then
                curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
                source "$HOME/.cargo/env"
            fi ;;
        bun)
            if prompt "Bun"; then
                curl -fsSL https://bun.sh/install | bash
                export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
            fi ;;
        sqlite)
            if prompt "SQLite"; then
                if [[ $OS == macos ]]; then
                    brew install sqlite3
                else
                    sudo apt-get update && sudo apt-get install -y sqlite3 libsqlite3-dev
                fi
            fi ;;
        jq)
            if prompt "jq"; then
                brew install jq
            fi ;;
        linux-deps)
            if prompt "Linux system dependencies (required for Tauri)"; then

        # checks for pacman package manager!
        if 
            command -v pacman &>/dev/null; then
                sudo pacman -Syu --noconfirm --needed pkgconf openssl libx11 \
                libxrandr libxinerama libxcursor libxi libxext \
                atk gtk3 webkit2gtk libsoup \
                glib2 gnome-screenshot       
        #checks for apt-get
        elif
            command -v apt-get &>/dev/null;then

                sudo apt-get update && sudo apt-get install -y \
                pkg-config libssl-dev libx11-dev libxdo-dev libxcb1-dev libxrandr-dev \
                libxinerama-dev libxcursor-dev libxi-dev libxext-dev \
                libatk1.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
                libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libglib2.0-dev \
                libayatana-appindicator3-dev gnome-screenshot

                #checks for dnf
        elif 
            command -v dnf &>/dev/null; then
                sudo dnf install -y \
                pkgconf-pkg-config openssl-devel libX11-devel libXrandr-devel \
                libXinerama-devel libXcursor-devel libXi-devel libXext-devel \
                atk-devel gtk3-devel webkit2gtk3-devel \
                javascriptcoregtk3-devel libsoup3-devel glib2-devel \
                libayatana-appindicator3-devel gnome-screenshot
                fi

# huge thanks to my friend mizufuwa from a different place for help writing the above! :3
            fi ;;
    esac
done

echo -e "\n${BLUE}Run ./setup.sh again to verify.${NC}"
