#!/usr/bin/env bash
# Release template: source copies require placeholder rendering before use.
# Qwen 1.x native bootstrap. Version storage and activation belong to the CLI.
set -euo pipefail
base_url='__BASE_URL__'
version=''
quiet=false
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo 'Missing version' >&2; exit 1; }
      version="${2#v}"
      [ -n "$version" ] || { echo 'Missing version' >&2; exit 1; }
      shift 2 ;;
    --quiet) quiet=true; args+=("$1"); shift ;;
    --force|--skip-path) args+=("$1"); shift ;;
    --help|-h) echo 'Qwen native installer: [--version <version>] [--force] [--skip-path] [--quiet]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
step() {
  if [ "$quiet" = false ]; then printf '%s\n' "$1" >&2; fi
}
download() {
  curl --proto '=https' --proto-redir '=https' -fSL "$3" \
    --retry 2 --connect-timeout 20 --max-time 300 "$1" -o "$2"
}
valid_version() {
  local number='(0|[1-9][0-9]*)' identifier='[0-9A-Za-z-]+'
  local suffix="$identifier(\.$identifier)*"
  [[ ${#1} -le 256 && "$1" =~ ^$number\.$number\.$number(-$suffix)?(\+$suffix)?$ ]]
}
manifest_version() { sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1; }
if [ -n "$version" ]; then valid_version "$version" || { echo 'Invalid Qwen version' >&2; exit 1; }; fi
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
step 'Finding the Qwen Code release...'
if [ -z "$version" ]; then
  download "$base_url/channels/manifest.json" "$temp_dir/latest.json" --silent
  version="$(manifest_version "$temp_dir/latest.json")"
  valid_version "$version" || { echo 'Invalid Qwen version in release manifest' >&2; exit 1; }
fi
# Pin the chosen version even if the channel advances during installation.
download "$base_url/channels/$version/manifest.json" "$temp_dir/manifest.json" --silent
[ "$(manifest_version "$temp_dir/manifest.json")" = "$version" ] || { echo 'Version manifest mismatch' >&2; exit 1; }
arch="$(uname -m)"
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
case "$(uname -s)" in
  Darwin)
    os=darwin
    if [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi ;;
  Linux)
    os=linux
    if (ldd --version 2>&1 || true) | grep -qi musl || [ -e /etc/alpine-release ]; then
      arch="$arch-musl"
    fi ;;
  *) echo 'Qwen native installation supports macOS and Linux.' >&2; exit 1 ;;
esac
# Read the publisher's canonical pretty-printed manifest without requiring Node/jq.
file_info="$(awk -v wanted_os="$os" -v wanted_arch="$arch" '
function value(line) { sub(/^[^:]*:[[:space:]]*"/, "", line); sub(/"[[:space:]]*,?[[:space:]]*$/, "", line); return line }
/^[[:space:]]*\{/ { os=""; arch=""; url=""; hash="" }
/"os"[[:space:]]*:/ { os=value($0) }
/"arch"[[:space:]]*:/ { arch=value($0) }
/"url"[[:space:]]*:/ { url=value($0) }
/"sha256"[[:space:]]*:/ { hash=value($0) }
/^[[:space:]]*}/ { if (os==wanted_os && arch==wanted_arch) { print url; print hash; exit } }
' "$temp_dir/manifest.json")"
[ -n "$file_info" ] || { echo "Release $version has no binary for $os/$arch" >&2; exit 1; }
archive_url="${file_info%%$'\n'*}"
expected="${file_info#*$'\n'}"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Invalid archive digest' >&2; exit 1; }
[[ "$archive_url" == https://* ]] || { echo 'HTTPS archive URL required' >&2; exit 1; }
step ''
step "Downloading Qwen Code $version ($os/$arch)..."
download_mode=--silent
# In curl | bash, stdin is a pipe, while stderr can still be a terminal.
if [ "$quiet" = false ] && [ -t 2 ] && [ "${TERM:-}" != dumb ]; then
  download_mode=--progress-bar
fi
COLUMNS=52 download "$archive_url" "$temp_dir/qwen.tar.gz" "$download_mode"
step 'Verifying and installing...'
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$temp_dir/qwen.tar.gz" | awk '{print $1}')"
else actual="$(shasum -a 256 "$temp_dir/qwen.tar.gz" | awk '{print $1}')"; fi
[ "$actual" = "$expected" ] || { echo 'Qwen archive SHA-256 mismatch' >&2; exit 1; }
# Extract only the expected program, not arbitrary members from the archive.
tar -xzf "$temp_dir/qwen.tar.gz" -C "$temp_dir" ./qwen
[ -f "$temp_dir/qwen" ] && [ ! -L "$temp_dir/qwen" ] || { echo 'Missing Qwen binary' >&2; exit 1; }
chmod 755 "$temp_dir/qwen"
# Bash 3.2 treats an empty array as unset under nounset.
"$temp_dir/qwen" install --version "$version" ${args[@]+"${args[@]}"}
