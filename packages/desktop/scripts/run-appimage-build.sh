#!/usr/bin/env bash
set -euo pipefail

arch="$(uname -m)"
case "$arch" in
  x86_64) sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d ;;
  aarch64) sha256=620095110d693282b8ebeb244a95b5e911cf8f65f76c88b4b47d16ae6346fcff ;;
  *) echo "Unsupported AppImage build architecture: $arch" >&2; exit 1 ;;
esac

# Tauri 2.11.4 downloads an older linuxdeploy that ignores the exclusion
# environment variable. Seed its cache for this invocation only.
XDG_CACHE_HOME="$(mktemp -d)"
export XDG_CACHE_HOME
trap 'rm -rf -- "$XDG_CACHE_HOME"' EXIT
mkdir -p "$XDG_CACHE_HOME/tauri"
tool="$XDG_CACHE_HOME/tauri/linuxdeploy-$arch.AppImage"
curl --fail --silent --show-error --location --retry 3 --output "$tool" \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-$arch.AppImage"
printf '%s  %s\n' "$sha256" "$tool" | sha256sum --check -
chmod +x "$tool"

# Keep the Wayland family on the host so its EGL driver uses a matching client.
export LINUXDEPLOY_EXCLUDED_LIBRARIES='libwayland-client.so*;libwayland-cursor.so*;libwayland-egl.so*;libwayland-server.so*'
"$@"
