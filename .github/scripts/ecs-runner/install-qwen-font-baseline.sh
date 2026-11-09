#!/usr/bin/env bash
# Put one self-hosted pool host onto the x64 font baseline, then verify it.
#
# The x64 ECS pool ships DejaVu Sans through its base image, so fontconfig
# resolves `sans-serif` to it. The ARM64 pool images (Ubuntu 26.04 minimal)
# do not, and fontconfig falls back to WenQuanYi Zen Hei for Latin text as
# well as CJK. That is a ~26 px difference per long string, which is enough to
# flip the web-shell layout assertions (#15383).
#
# Idempotent: re-running installs nothing and only re-verifies.
#
# Usage: install-qwen-font-baseline.sh [--with-metrics | --user-terminal]
# Exit: 0 = host is at the baseline, 1 = setup or verification failed.
set -euo pipefail

# The unit job uses an isolated HOME, and slim containers may have neither
# fonts nor fontconfig's CLI tools. Give sharp both weights without elevation.
if [ "${1:-}" = --user-terminal ]; then
  font_dir="${HOME}/.local/share/fonts/qwen-ci-terminal"
  config_dir="${HOME}/.config/qwen-ci-terminal"
  mkdir -p "$font_dir" "$config_dir"
  system_fonts=/usr/share/fonts/truetype/dejavu
  if [ -s "$system_fonts/DejaVuSansMono.ttf" ] && [ -s "$system_fonts/DejaVuSansMono-Bold.ttf" ]; then
    cp "$system_fonts/DejaVuSansMono.ttf" "$system_fonts/DejaVuSansMono-Bold.ttf" "$font_dir/"
  elif [ ! -s "$font_dir/DejaVuSansMono.ttf" ] || [ ! -s "$font_dir/DejaVuSansMono-Bold.ttf" ]; then
    font_stage="$(mktemp -d "${RUNNER_TEMP:-/tmp}/qwen-terminal-fonts.XXXXXX")"
    trap 'rm -rf -- "$font_stage"' EXIT
    mkdir -p "$font_stage/lists/partial" "$font_stage/packages"
    apt-get -o "Dir::State::lists=$font_stage/lists" update -qq
    # Bookworm includes Mono in core; newer Debian/Ubuntu split it out.
    package=fonts-dejavu-core
    if apt-cache -o "Dir::State::lists=$font_stage/lists" show fonts-dejavu-mono >/dev/null 2>&1; then
      package=fonts-dejavu-mono
    fi
    (
      cd "$font_stage/packages"
      apt-get -o "Dir::State::lists=$font_stage/lists" download "$package"
    )
    for archive in "$font_stage"/packages/*.deb; do
      dpkg-deb --extract "$archive" "$font_stage/extracted"
    done
    cp "$font_stage/extracted/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf" \
      "$font_stage/extracted/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" "$font_dir/"
  fi
  # Relative XML paths also handle spaces and XML metacharacters in HOME.
  cat > "$config_dir/fonts.conf" <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir prefix="relative">../../.local/share/fonts/qwen-ci-terminal</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
EOF
  printf 'FONTCONFIG_FILE=%s\n' "$config_dir/fonts.conf" >> "${GITHUB_ENV:?}"
  echo 'Terminal fonts ready: DejaVu Sans Mono regular and bold'
  exit 0
fi

packages=(fonts-dejavu-core fonts-dejavu-mono)

# Test seam: the unit test cannot be root, and the install plan is worth
# covering. Production runs never set this.
if [ "${QWEN_FONT_BASELINE_TEST_ALLOW_NON_ROOT:-0}" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer as root (the pool hosts are provisioned as root).' >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-query >/dev/null 2>&1; then
  echo 'This installer targets Debian/Ubuntu pool hosts (apt-get + dpkg-query).' >&2
  exit 1
fi

missing=()
for package in "${packages[@]}"; do
  status=$(dpkg-query -W -f='${Status}' "${package}" 2>/dev/null || true)
  case "${status}" in
    'install ok installed') ;;
    *) missing+=("${package}") ;;
  esac
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo 'DejaVu packages are already installed'
fi

# Runners pick a new font up per job; no service restart is needed.
fc-cache -f >/dev/null 2>&1 || true

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "${script_dir}/check-font-baseline.sh" "$@"
