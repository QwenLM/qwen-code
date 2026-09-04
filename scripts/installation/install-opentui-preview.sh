#!/usr/bin/env sh
# Install a gated release's bun/OpenTUI preview archive into a scratch
# directory. Does not touch PATH, the hosted installer chain, or an existing
# classic installation; delete the install directory to uninstall.
#
# Usage:
#   install-opentui-preview.sh --tag v0.1.11 [--target TARGET] [--dir DIR]
#   install-opentui-preview.sh --archive FILE [--dir DIR]

set -eu

REPO="QwenLM/qwen-code"

fail() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Install the bun/OpenTUI preview flavor (qwen-code-*-opentui-preview.tar.gz)
from a gated GitHub release into a scratch directory.

Options:
  --tag TAG        Release tag, e.g. v0.1.11. Required unless --archive.
  --target TARGET  linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64.
                   Defaults to the current platform.
  --dir DIR        Install directory. Defaults to ~/.qwen-preview.
  --archive FILE   Install a local archive instead of downloading one
                   (skips SHA256 verification).
  -h, --help       Show this help.
EOF
}

tag=""
target=""
dir="${HOME}/.qwen-preview"
archive=""

while [ $# -gt 0 ]; do
    case "$1" in
        --tag)
            [ $# -ge 2 ] || fail "--tag requires a value"
            tag="$2"
            shift 2
            ;;
        --target)
            [ $# -ge 2 ] || fail "--target requires a value"
            target="$2"
            shift 2
            ;;
        --dir)
            [ $# -ge 2 ] || fail "--dir requires a value"
            dir="$2"
            shift 2
            ;;
        --archive)
            [ $# -ge 2 ] || fail "--archive requires a value"
            archive="$2"
            shift 2
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            fail "unknown argument: $1"
            ;;
    esac
done

case "${tag}" in
    v[0-9A-Za-z.-]*) ;;
    *) [ -n "${archive}" ] || fail "--tag must look like v0.1.11 (required unless --archive)" ;;
esac

if [ -z "${target}" ]; then
    os=$(uname -s)
    arch=$(uname -m)
    case "${os}" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        *) fail "unsupported platform: ${os} (use the .ps1 script on Windows)" ;;
    esac
    case "${arch}" in
        x86_64) arch="x64" ;;
        arm64 | aarch64) arch="arm64" ;;
        *) fail "unsupported architecture: ${arch}" ;;
    esac
    target="${os}-${arch}"
fi

case "${target}" in
    linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64) ;;
    *) fail "unsupported --target: ${target} (preview flavors: linux-x64 linux-arm64 darwin-arm64 darwin-x64)" ;;
esac

archive_name="qwen-code-${target}-opentui-preview.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --connect-timeout 15 --max-time 600 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$1" -O "$2"
    else
        fail "neither curl nor wget is available"
    fi
}

if [ -n "${archive}" ]; then
    [ -f "${archive}" ] || fail "--archive file not found: ${archive}"
    archive_path="${archive}"
    printf 'warning: --archive given; skipping download and SHA256 verification\n' >&2
else
    base_url="https://github.com/${REPO}/releases/download/${tag}"
    fetch "${base_url}/${archive_name}" "${work}/${archive_name}" ||
        fail "download failed: ${base_url}/${archive_name} (was ${tag} released with the OpenTUI preview flavor enabled?)"
    fetch "${base_url}/SHA256SUMS" "${work}/SHA256SUMS" ||
        fail "download failed: ${base_url}/SHA256SUMS"

    expected=$(awk -v n="${archive_name}" '$2 == n || $2 == "*" n { print $1 }' "${work}/SHA256SUMS")
    [ -n "${expected}" ] || fail "${archive_name} is not listed in the release SHA256SUMS"
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "${work}/${archive_name}" | cut -d' ' -f1)
    else
        actual=$(shasum -a 256 "${work}/${archive_name}" | cut -d' ' -f1)
    fi
    [ "${actual}" = "${expected}" ] ||
        fail "SHA256 mismatch for ${archive_name}: expected ${expected}, got ${actual}"
    archive_path="${work}/${archive_name}"
fi

mkdir -p "${dir}"
rm -rf "${dir}/qwen-code"
tar -xzf "${archive_path}" -C "${dir}"

printf 'installed: %s/qwen-code\n' "${dir}"
printf 'run: %s/qwen-code/bin/qwen\n' "${dir}"
