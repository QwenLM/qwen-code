#!/usr/bin/env bash

# Qwen Code Installation Script
# Installs Qwen Code from a standalone archive when available, with npm fallback.
# This script intentionally does not install Node.js or change npm config.
#
# Usage:
#   install-qwen-standalone.sh --source [github|npm|internal|local-build]
#   install-qwen-standalone.sh --method [detect|standalone|npm]

if [ -z "${BASH_VERSION}" ] && [ -z "${__QWEN_INSTALL_REEXEC:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        if [ -f "${0}" ]; then
            export __QWEN_INSTALL_REEXEC=1
            exec bash -- "${0}" "$@"
        fi

        echo "Error: This script requires bash. Run the installer with: curl ... | bash"
        exit 1
    fi

    echo "Error: This script requires bash. Please install bash first."
    exit 1
fi

set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}INFO:${NC} $1"
}

log_success() {
    echo -e "${GREEN}SUCCESS:${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}WARNING:${NC} $1"
}

log_error() {
    echo -e "${RED}ERROR:${NC} $1"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

TEMP_DIRS=()

cleanup_temp_dirs() {
    local temp_dir
    for temp_dir in "${TEMP_DIRS[@]}"; do
        if [[ -n "${temp_dir}" ]]; then
            rm -rf "${temp_dir}"
        fi
    done
}

register_temp_dir() {
    local temp_dir="$1"
    TEMP_DIRS+=("${temp_dir}")
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

trap cleanup_temp_dirs EXIT
trap 'cleanup_temp_dirs; exit 130' INT
trap 'cleanup_temp_dirs; exit 143' TERM

print_usage() {
    cat <<EOF
Qwen Code Installer

Usage: $0 [OPTIONS]

Options:
  -s, --source SOURCE      Record the installation source.
  --method METHOD          Install method: detect, standalone, or npm.
                           Defaults to QWEN_INSTALL_METHOD or detect.
  --mirror MIRROR          Standalone archive mirror: auto, github, or aliyun.
                           Defaults to QWEN_INSTALL_MIRROR or auto, which picks
                           whichever responds first via a HEAD probe.
  --base-url URL           Override standalone archive base URL.
  --archive PATH           Install from a local standalone archive.
  --version VERSION        Standalone release version. Defaults to latest.
  --registry REGISTRY      npm registry to use for npm fallback.
                           Defaults to QWEN_NPM_REGISTRY or https://registry.npmmirror.com
  --no-modify-path         Do not append PATH to the user's shell rc file even
                           when a shadowing 'qwen' is detected.
  -h, --help               Show this help message.

Examples:
  curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
  curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash -s -- --source github
  curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash -s -- --method standalone
  ./install-qwen-standalone.sh --archive ./qwen-code-linux-x64.tar.gz
EOF
}

SOURCE="unknown"
METHOD="${QWEN_INSTALL_METHOD:-}"
MIRROR="${QWEN_INSTALL_MIRROR:-auto}"
BASE_URL="${QWEN_INSTALL_BASE_URL:-}"
ARCHIVE_PATH="${QWEN_INSTALL_ARCHIVE:-}"
VERSION="${QWEN_INSTALL_VERSION:-latest}"
NO_MODIFY_PATH="${QWEN_NO_MODIFY_PATH:-0}"
NPM_REGISTRY="${QWEN_NPM_REGISTRY:-https://registry.npmmirror.com}"
INSTALL_ROOT="${QWEN_INSTALL_ROOT:-${HOME:-}/.local}"
if [[ -n "${QWEN_INSTALL_LIB_DIR:-}" ]]; then
    INSTALL_LIB_DIR="${QWEN_INSTALL_LIB_DIR}"
    INSTALL_LIB_PARENT="$(dirname "${INSTALL_LIB_DIR}")"
else
    INSTALL_LIB_PARENT="${QWEN_INSTALL_LIB_PARENT:-${INSTALL_ROOT}/lib}"
    INSTALL_LIB_DIR="${INSTALL_LIB_PARENT}/qwen-code"
fi
INSTALL_BIN_DIR="${QWEN_INSTALL_BIN_DIR:-${INSTALL_ROOT}/bin}"

validate_source() {
    if [[ "${SOURCE}" == "unknown" ]]; then
        return 0
    fi

    if [[ "${SOURCE}" =~ ^[A-Za-z0-9._-]+$ ]]; then
        return 0
    fi

    log_error "--source may only contain letters, numbers, dot, underscore, or dash."
    exit 1
}

validate_https_url() {
    local value="$1"
    local option_name="$2"

    if [[ -z "${value}" ]]; then
        return 0
    fi

    if [[ "${value}" == https://* ]]; then
        return 0
    fi

    log_error "${option_name} must start with https://"
    exit 1
}

validate_version() {
    if [[ "${VERSION}" == "latest" ]]; then
        return 0
    fi

    if [[ "${VERSION}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$ ]]; then
        return 0
    fi

    log_error "--version must be 'latest' or a semver string."
    exit 1
}

validate_github_repo() {
    local github_repo="${QWEN_INSTALL_GITHUB_REPO:-QwenLM/qwen-code}"
    if [[ "${github_repo}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
        return 0
    fi

    log_error "QWEN_INSTALL_GITHUB_REPO must be in owner/repo format."
    exit 1
}

validate_install_path() {
    local value="$1"
    local option_name="$2"

    if [[ -z "${value}" ]]; then
        log_error "${option_name} must not be empty."
        exit 1
    fi

    case "${value}" in
        *$'\n'*|*$'\r'*)
            log_error "${option_name} must not contain newlines."
            exit 1
            ;;
    esac

    if [[ "${value}" != /* ]]; then
        log_error "${option_name} must be an absolute path."
        exit 1
    fi
}

validate_options() {
    METHOD="${METHOD:-detect}"

    case "${METHOD}" in
        detect|standalone|npm)
            ;;
        *)
            log_error "--method must be detect, standalone, or npm."
            exit 1
            ;;
    esac

    case "${MIRROR}" in
        auto|github|aliyun)
            ;;
        *)
            log_error "--mirror must be auto, github, or aliyun."
            exit 1
            ;;
    esac

    validate_https_url "${BASE_URL}" "--base-url"
    validate_https_url "${NPM_REGISTRY}" "--registry"
    validate_version
    validate_github_repo
    validate_install_path "${INSTALL_ROOT}" "QWEN_INSTALL_ROOT"
    validate_install_path "${INSTALL_LIB_PARENT}" "QWEN_INSTALL_LIB_PARENT"
    validate_install_path "${INSTALL_LIB_DIR}" "QWEN_INSTALL_LIB_DIR"
    validate_install_path "${INSTALL_BIN_DIR}" "QWEN_INSTALL_BIN_DIR"
    validate_source
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--source)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--source requires a value"
                exit 1
            fi
            SOURCE="$2"
            shift 2
            ;;
        --method)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--method requires a value"
                exit 1
            fi
            METHOD="$2"
            shift 2
            ;;
        --mirror)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--mirror requires a value"
                exit 1
            fi
            MIRROR="$2"
            shift 2
            ;;
        --base-url)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--base-url requires a value"
                exit 1
            fi
            validate_https_url "$2" "--base-url"
            BASE_URL="$2"
            shift 2
            ;;
        --archive)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--archive requires a value"
                exit 1
            fi
            ARCHIVE_PATH="$2"
            shift 2
            ;;
        --version)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--version requires a value"
                exit 1
            fi
            VERSION="$2"
            shift 2
            ;;
        --registry)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                log_error "--registry requires a value"
                exit 1
            fi
            NPM_REGISTRY="$2"
            shift 2
            ;;
        --no-modify-path)
            NO_MODIFY_PATH=1
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo ""
            print_usage
            exit 1
            ;;
    esac
done

# Validate all user-supplied options before doing network or filesystem work.
validate_options

print_header() {
    echo "=========================================="
    echo "   Qwen Code Installation Script"
    echo "=========================================="
    echo ""
    log_info "System: $(uname -s 2>/dev/null || echo unknown) $(uname -r 2>/dev/null || true)"
    log_info "Install method: ${METHOD}"
    if [[ "${METHOD}" != "npm" ]]; then
        log_info "Standalone mirror: ${MIRROR}"
        if [[ -n "${BASE_URL}" ]]; then
            log_info "Standalone base URL: ${BASE_URL}"
        fi
        if [[ -n "${ARCHIVE_PATH}" ]]; then
            log_info "Standalone archive: ${ARCHIVE_PATH}"
        else
            log_info "Standalone version: ${VERSION}"
        fi
    fi
    if [[ "${METHOD}" != "standalone" ]]; then
        log_info "npm registry: ${NPM_REGISTRY}"
    fi
    if [[ "${SOURCE}" != "unknown" ]]; then
        log_info "Installation source: ${SOURCE}"
    fi
    echo ""
}

print_node_help() {
    echo ""
    echo "Node.js 22 or newer is required before installing Qwen Code with npm."
    echo ""
    echo "Install Node.js, then rerun this installer:"
    case "$(uname -s 2>/dev/null || echo unknown)" in
        Darwin)
            echo "  brew install node"
            echo "  # or download from https://nodejs.org/"
            ;;
        Linux)
            echo "  # Use your distribution package manager or:"
            echo "  https://nodejs.org/en/download/package-manager"
            ;;
        *)
            echo "  https://nodejs.org/"
            ;;
    esac
    echo ""
    echo "If you already use a Node version manager, activate Node.js 22+"
    echo "in this shell before rerunning the installer."
}

require_node() {
    if ! command_exists node; then
        log_error "Node.js was not found."
        print_node_help
        return 1
    fi

    local node_version
    node_version=$(node -p "process.versions.node" 2>/dev/null || true)
    local node_major
    node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)

    if [[ -z "${node_major}" ]] || ! [[ "${node_major}" =~ ^[0-9]+$ ]]; then
        log_error "Unable to determine Node.js version."
        print_node_help
        return 1
    fi

    if [[ "${node_major}" -lt 22 ]]; then
        log_error "Node.js ${node_version:-unknown} is installed, but Node.js 22 or newer is required."
        print_node_help
        return 1
    fi

    log_success "Node.js ${node_version} detected."
}

require_npm() {
    if command_exists npm; then
        log_success "npm $(npm -v 2>/dev/null || echo unknown) detected."
        return 0
    fi

    log_error "npm was not found."
    echo ""
    echo "Please install Node.js with npm included, then rerun this installer."
    echo "Download Node.js from https://nodejs.org/ if your package manager"
    echo "installed Node without npm."
    return 1
}

get_npm_global_bin() {
    local prefix
    prefix=$(npm prefix -g 2>/dev/null || true)

    if [[ -z "${prefix}" ]]; then
        return 0
    fi

    case "$(uname -s 2>/dev/null || echo unknown)" in
        MINGW*|MSYS*|CYGWIN*)
            echo "${prefix}"
            ;;
        *)
            echo "${prefix}/bin"
            ;;
    esac
}

create_source_json() {
    if [[ "${SOURCE}" == "unknown" ]]; then
        return 0
    fi

    local qwen_dir="${HOME}/.qwen"
    mkdir -p "${qwen_dir}"

    local escaped_source
    escaped_source=$(printf '%s' "${SOURCE}" | sed 's/\\/\\\\/g; s/"/\\"/g')

    cat > "${qwen_dir}/source.json" <<EOF
{
  "source": "${escaped_source}"
}
EOF

    log_success "Installation source saved to ~/.qwen/source.json"
}

detect_target() {
    local os
    os=$(uname -s 2>/dev/null || echo unknown)
    local arch
    arch=$(uname -m 2>/dev/null || echo unknown)

    case "${os}" in
        Darwin)
            os="darwin"
            ;;
        Linux)
            os="linux"
            ;;
        *)
            return 1
            ;;
    esac

    case "${arch}" in
        x86_64|amd64)
            arch="x64"
            ;;
        arm64|aarch64)
            arch="arm64"
            ;;
        *)
            return 1
            ;;
    esac

    echo "${os}-${arch}"
}

archive_extension_for_target() {
    case "$1" in
        darwin-*|linux-*)
            echo "tar.gz"
            ;;
        *)
            return 1
            ;;
    esac
}

release_version_path() {
    if [[ "${VERSION}" == "latest" ]]; then
        echo "latest"
        return 0
    fi

    case "${VERSION}" in
        v*)
            echo "${VERSION}"
            ;;
        *)
            echo "v${VERSION}"
            ;;
    esac
}

# When a shadowing 'qwen' is detected, append a PATH prepend to the user's
# shell rc file at the very end. Putting it at the END means our prepend runs
# AFTER any earlier PATH munging in the rc file (e.g., other tools' shell
# init), so our installed_bin wins. Idempotent via a marker comment.
maybe_update_shell_path() {
    local install_bin_dir="$1"

    [[ "${NO_MODIFY_PATH:-0}" == "1" ]] && return 0
    [[ -z "${install_bin_dir}" ]] && return 0
    [[ -z "${HOME:-}" ]] && return 0

    local rc_file=""
    case "${SHELL:-}" in
        */zsh)  rc_file="${HOME}/.zshrc" ;;
        */bash)
            if [[ -f "${HOME}/.bashrc" ]]; then
                rc_file="${HOME}/.bashrc"
            elif [[ -f "${HOME}/.bash_profile" ]]; then
                rc_file="${HOME}/.bash_profile"
            else
                rc_file="${HOME}/.bashrc"
            fi
            ;;
        */fish) rc_file="${HOME}/.config/fish/config.fish" ;;
        *)      rc_file="${HOME}/.profile" ;;
    esac

    [[ -z "${rc_file}" ]] && return 0

    local marker="# Added by qwen-code installer (multi-qwen shadow fix)"
    local quoted_install_bin_dir
    quoted_install_bin_dir=$(shell_quote "${install_bin_dir}")
    local export_line
    if [[ "${rc_file}" == *config.fish ]]; then
        export_line="set -gx PATH ${quoted_install_bin_dir} \$PATH"
    else
        export_line="export PATH=${quoted_install_bin_dir}:\$PATH"
    fi

    if [[ -f "${rc_file}" ]] && grep -qF "${marker}" "${rc_file}" 2>/dev/null; then
        log_info "PATH update already present in ${rc_file} (skipping)."
        return 0
    fi

    mkdir -p "$(dirname "${rc_file}")" 2>/dev/null || true
    {
        echo ""
        echo "${marker}"
        echo "${export_line}"
    } >> "${rc_file}" || {
        log_warning "Could not write PATH update to ${rc_file}."
        return 0
    }

    log_success "Appended PATH prepend to ${rc_file}"
    log_info "Open a new terminal, or run: source ${rc_file}"
}

github_base_url_for_version() {
    local version_path="$1"
    local github_repo="${QWEN_INSTALL_GITHUB_REPO:-QwenLM/qwen-code}"
    if [[ "${version_path}" == "latest" ]]; then
        echo "https://github.com/${github_repo}/releases/latest/download"
    else
        echo "https://github.com/${github_repo}/releases/download/${version_path}"
    fi
}

aliyun_base_url_for_version() {
    local version_path="$1"
    echo "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/${version_path}"
}

# Race two HEAD probes; print "aliyun" or "github" based on which mirror's
# SHA256SUMS responds first, or "timeout" if neither responds before the
# deadline. Caller decides what to do with "timeout" (currently: log it and
# fall back to github).
race_mirror_head() {
    local timeout="${1:-2}"
    local gh_url="$2"
    local oss_url="$3"
    local tmpdir
    tmpdir=$(mktemp -d -t qwen-mirror.XXXXXX 2>/dev/null) || tmpdir="/tmp/qwen-mirror.$$"
    mkdir -p "${tmpdir}" 2>/dev/null || true

    (curl -fsIL -m "${timeout}" -o /dev/null "${oss_url}" >/dev/null 2>&1 && : > "${tmpdir}/aliyun") &
    local oss_pid=$!
    (curl -fsIL -m "${timeout}" -o /dev/null "${gh_url}"  >/dev/null 2>&1 && : > "${tmpdir}/github") &
    local gh_pid=$!

    local winner=""
    local elapsed=0
    local max=$((timeout * 10 + 5))
    while [[ -z "${winner}" && "${elapsed}" -lt "${max}" ]]; do
        # Probe OSS first to break ties in favor of the closer mirror for CN users.
        [[ -e "${tmpdir}/aliyun" ]] && winner="aliyun" && break
        [[ -e "${tmpdir}/github" ]] && winner="github" && break
        sleep 0.1
        elapsed=$((elapsed + 1))
    done

    kill "${oss_pid}" "${gh_pid}" 2>/dev/null || true
    wait "${oss_pid}" "${gh_pid}" 2>/dev/null || true
    rm -rf "${tmpdir}" 2>/dev/null || true

    echo "${winner:-timeout}"
}

standalone_base_url() {
    if [[ -n "${BASE_URL}" ]]; then
        echo "${BASE_URL%/}"
        return 0
    fi

    local version_path
    version_path=$(release_version_path)

    if [[ "${MIRROR}" == "auto" ]]; then
        local gh_head oss_head selected
        gh_head="$(github_base_url_for_version "${version_path}")/SHA256SUMS"
        oss_head="$(aliyun_base_url_for_version "${version_path}")/SHA256SUMS"
        selected=$(race_mirror_head 2 "${gh_head}" "${oss_head}")
        if [[ "${selected}" == "timeout" ]]; then
            log_info "Mirror auto-selection timed out; defaulting to github." >&2
            selected="github"
        else
            log_info "Mirror auto-selected via HEAD probe: ${selected}" >&2
        fi
        MIRROR="${selected}"
    fi

    if [[ "${MIRROR}" == "aliyun" ]]; then
        aliyun_base_url_for_version "${version_path}"
        return 0
    fi

    github_base_url_for_version "${version_path}"
}

download_file() {
    local url="$1"
    local destination="$2"

    # Show progress only when stderr is a terminal (so CI / non-tty stays clean).
    # `curl ... | bash` keeps stderr connected to the user's terminal even though
    # stdin is a pipe, so progress shows correctly during normal usage.
    local show_progress=0
    if [ -t 2 ] && [ "${QWEN_INSTALL_QUIET:-0}" != "1" ]; then
        show_progress=1
    fi

    if command_exists curl; then
        if [ "${show_progress}" = "1" ]; then
            curl -fL --progress-bar --retry 2 "${url}" -o "${destination}"
        else
            curl -fsSL --retry 2 "${url}" -o "${destination}"
        fi
        return $?
    fi

    if command_exists wget; then
        if [ "${show_progress}" = "1" ]; then
            wget --show-progress --tries=3 "${url}" -O "${destination}" || return 1
        else
            wget -q --tries=3 "${url}" -O "${destination}" || return 1
        fi
        return $?
    fi

    log_error "curl or wget is required to download the standalone archive."
    return 1
}

url_exists() {
    local url="$1"

    if command_exists curl; then
        curl -fsIL --retry 1 "${url}" >/dev/null 2>&1
        return $?
    fi

    if command_exists wget; then
        wget -q --spider "${url}" >/dev/null 2>&1
        return $?
    fi

    return 1
}

sha256_file() {
    local file_path="$1"

    if command_exists sha256sum; then
        sha256sum "${file_path}" | awk '{print $1}'
        return 0
    fi

    if command_exists shasum; then
        shasum -a 256 "${file_path}" | awk '{print $1}'
        return 0
    fi

    return 1
}

verify_checksum() {
    local archive_path="$1"
    local checksum_source="$2"
    local archive_name="$3"
    local checksum_file="${checksum_source}"
    local temp_checksum=""

    if [[ -z "${checksum_file}" ]]; then
        checksum_file="$(dirname "${archive_path}")/SHA256SUMS"
    elif [[ "${checksum_file}" == http://* || "${checksum_file}" == https://* ]]; then
        temp_checksum="$(mktemp)"
        if ! download_file "${checksum_file}" "${temp_checksum}"; then
            rm -f "${temp_checksum}"
            log_error "Could not download SHA256SUMS for checksum verification."
            return 1
        fi
        checksum_file="${temp_checksum}"
    fi

    if [[ ! -f "${checksum_file}" ]]; then
        rm -f "${temp_checksum}"
        log_error "SHA256SUMS not found; cannot verify archive."
        return 1
    fi

    local expected
    expected=$(awk -v archive_name="${archive_name}" '
        {
            name = $2
            sub(/^\*/, "", name)
            if (name == archive_name) {
                print $1
                exit
            }
        }
    ' "${checksum_file}")
    if [[ -z "${expected}" ]]; then
        rm -f "${temp_checksum}"
        log_error "Checksum entry for ${archive_name} not found."
        return 1
    fi

    local actual
    if ! actual=$(sha256_file "${archive_path}"); then
        rm -f "${temp_checksum}"
        log_error "No SHA-256 utility found; cannot verify archive."
        return 1
    fi

    rm -f "${temp_checksum}"

    if [[ "${expected}" != "${actual}" ]]; then
        log_error "Checksum verification failed for ${archive_name}."
        return 1
    fi

    log_success "Checksum verified for ${archive_name}."
}

validate_archive_entry_path() {
    local entry="$1"

    while [[ "${entry}" == ./* ]]; do
        entry="${entry#./}"
    done

    # Reject entries containing CR/LF so a `..\r` or `..\n` entry cannot
    # bypass the literal `..` glob below.
    case "${entry}" in
        *$'\r'*|*$'\n'*)
            log_error "Archive contains unsafe path with control character: ${entry}"
            return 1
            ;;
    esac

    case "${entry}" in
        ""|/*|..|../*|*/..|*/../*|*\\*)
            log_error "Archive contains unsafe path: ${entry:-<empty>}"
            return 1
            ;;
    esac
}

validate_archive_contents() {
    local archive_path="$1"
    local entries
    local entry

    case "${archive_path}" in
        *.zip)
            if ! command_exists unzip; then
                log_error "unzip is required to inspect ${archive_path}."
                return 1
            fi
            if ! entries=$(unzip -Z1 "${archive_path}"); then
                log_error "Failed to inspect archive entries: ${archive_path}"
                return 1
            fi
            ;;
        *.tar.gz|*.tgz|*.tar.xz)
            if ! entries=$(tar -tf "${archive_path}"); then
                log_error "Failed to inspect archive entries: ${archive_path}"
                return 1
            fi
            ;;
        *)
            log_error "Unsupported archive format: ${archive_path}"
            return 1
            ;;
    esac

    while IFS= read -r entry; do
        validate_archive_entry_path "${entry}" || return 1
    done <<< "${entries}"
}

extract_archive() {
    local archive_path="$1"
    local destination="$2"

    mkdir -p "${destination}" || return 1
    validate_archive_contents "${archive_path}" || return 1

    case "${archive_path}" in
        *.zip)
            if ! command_exists unzip; then
                log_error "unzip is required to extract ${archive_path}."
                return 1
            fi
            unzip -q "${archive_path}" -d "${destination}" || return 1
            ;;
        *.tar.gz|*.tgz)
            tar -xzf "${archive_path}" -C "${destination}" || return 1
            ;;
        *.tar.xz)
            tar -xf "${archive_path}" -C "${destination}" || return 1
            ;;
        *)
            log_error "Unsupported archive format: ${archive_path}"
            return 1
            ;;
    esac

    local symlink_entry
    symlink_entry=$(find "${destination}" -type l -print | sed -n '1p')
    if [[ -n "${symlink_entry}" ]]; then
        log_error "Archive contains symlinks; refusing to install."
        return 1
    fi
}

ensure_managed_install_dir() {
    local install_dir="$1"

    if [[ ! -e "${install_dir}" ]]; then
        return 0
    fi

    if is_qwen_standalone_install_dir "${install_dir}"; then
        return 0
    fi

    log_error "${install_dir} exists but is not a Qwen Code standalone install."
    log_error "Refusing to overwrite it. Move or remove it manually, then rerun the installer."
    return 1
}

is_qwen_standalone_install_dir() {
    local install_dir="$1"
    local manifest_path="${install_dir}/manifest.json"

    [[ -f "${manifest_path}" ]] || return 1
    # Manifest format is produced by writeManifest in create-standalone-package.js.
    # Keep these grep checks in sync if that JSON layout changes.
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"@qwen-code/qwen-code"' "${manifest_path}" 2>/dev/null || return 1
    grep -Eq '"target"[[:space:]]*:[[:space:]]*"(darwin|linux)-(arm64|x64)"' "${manifest_path}" 2>/dev/null || return 1
    [[ -f "${install_dir}/bin/qwen" && ! -L "${install_dir}/bin/qwen" && -x "${install_dir}/bin/qwen" ]] || return 1
    [[ -f "${install_dir}/node/bin/node" && ! -L "${install_dir}/node/bin/node" && -x "${install_dir}/node/bin/node" ]] || return 1
}

write_unix_wrapper() {
    local wrapper_path="$1"
    local qwen_bin="$2"
    local quoted_qwen_bin
    quoted_qwen_bin=$(shell_quote "${qwen_bin}")

    cat > "${wrapper_path}" <<EOF
#!/usr/bin/env sh
exec ${quoted_qwen_bin} "\$@"
EOF
    chmod +x "${wrapper_path}"
}

install_standalone() {
    # Return 2 only when a standalone archive is unavailable and detect mode may
    # fall back to npm. Return 1 for integrity or install failures that should
    # not be masked by an automatic fallback.
    local target=""
    local archive_name=""
    local archive_path=""
    local checksum_source=""
    local temp_dir=""

    # Resolve the archive from a local file or from the configured release mirror.
    if [[ -n "${ARCHIVE_PATH}" ]]; then
        archive_path="${ARCHIVE_PATH}"
        archive_name="$(basename "${archive_path}")"
        if [[ ! -f "${archive_path}" ]]; then
            log_error "Standalone archive not found: ${archive_path}"
            return 1
        fi
    else
        if ! target=$(detect_target); then
            log_warning "Standalone archive is not available for this platform."
            return 2
        fi

        local archive_extension
        archive_extension=$(archive_extension_for_target "${target}")
        archive_name="qwen-code-${target}.${archive_extension}"

        local base_url
        base_url=$(standalone_base_url)
        local archive_url="${base_url}/${archive_name}"
        checksum_source="${base_url}/SHA256SUMS"

        if [[ "${METHOD}" == "detect" ]] && ! url_exists "${archive_url}"; then
            log_warning "Standalone archive not found: ${archive_name}"
            return 2
        fi

        temp_dir=$(mktemp -d)
        register_temp_dir "${temp_dir}"
        archive_path="${temp_dir}/${archive_name}"

        log_info "Downloading ${archive_url}"
        if ! download_file "${archive_url}" "${archive_path}"; then
            rm -rf "${temp_dir}"
            log_warning "Failed to download standalone archive."
            return 2
        fi
    fi

    if [[ -z "${temp_dir}" ]]; then
        temp_dir=$(mktemp -d)
        register_temp_dir "${temp_dir}"
    fi

    # Verify integrity before extraction or changing the install directory.
    if ! verify_checksum "${archive_path}" "${checksum_source}" "${archive_name}"; then
        rm -rf "${temp_dir}"
        return 1
    fi

    # Extract into a temporary directory, then validate required entry points.
    local extract_dir="${temp_dir}/extract"
    if ! extract_archive "${archive_path}" "${extract_dir}"; then
        rm -rf "${temp_dir}"
        return 1
    fi

    if [[ ! -f "${extract_dir}/qwen-code/bin/qwen" || -L "${extract_dir}/qwen-code/bin/qwen" || ! -x "${extract_dir}/qwen-code/bin/qwen" ]]; then
        log_error "Archive does not contain qwen-code/bin/qwen."
        rm -rf "${temp_dir}"
        return 1
    fi

    if [[ ! -f "${extract_dir}/qwen-code/node/bin/node" || -L "${extract_dir}/qwen-code/node/bin/node" || ! -x "${extract_dir}/qwen-code/node/bin/node" ]]; then
        log_error "Archive does not contain executable qwen-code/node/bin/node."
        rm -rf "${temp_dir}"
        return 1
    fi

    mkdir -p "${INSTALL_LIB_PARENT}" "${INSTALL_BIN_DIR}" || {
        rm -rf "${temp_dir}"
        return 1
    }

    # Stage into .new and keep .old so failed upgrades can roll back.
    local new_install_dir="${INSTALL_LIB_DIR}.new"
    local old_install_dir="${INSTALL_LIB_DIR}.old"
    local wrapper_tmp="${INSTALL_BIN_DIR}/qwen.new"
    if ! ensure_managed_install_dir "${INSTALL_LIB_DIR}" ||
        ! ensure_managed_install_dir "${new_install_dir}" ||
        ! ensure_managed_install_dir "${old_install_dir}"; then
        rm -rf "${temp_dir}"
        return 1
    fi
    rm -rf "${new_install_dir}" "${old_install_dir}" "${wrapper_tmp}"
    mv "${extract_dir}/qwen-code" "${new_install_dir}"

    if ! write_unix_wrapper "${wrapper_tmp}" "${INSTALL_LIB_DIR}/bin/qwen"; then
        rm -rf "${temp_dir}" "${new_install_dir}" "${wrapper_tmp}"
        log_error "Failed to create qwen wrapper in ${INSTALL_BIN_DIR}."
        return 1
    fi

    if [[ -e "${INSTALL_LIB_DIR}" ]]; then
        mv "${INSTALL_LIB_DIR}" "${old_install_dir}"
    fi

    if ! mv "${new_install_dir}" "${INSTALL_LIB_DIR}"; then
        if [[ -e "${old_install_dir}" ]]; then
            mv "${old_install_dir}" "${INSTALL_LIB_DIR}"
        fi
        rm -rf "${temp_dir}" "${wrapper_tmp}"
        log_error "Failed to install standalone archive to ${INSTALL_LIB_DIR}."
        return 1
    fi

    if ! mv -f "${wrapper_tmp}" "${INSTALL_BIN_DIR}/qwen"; then
        rm -rf "${INSTALL_LIB_DIR}" "${wrapper_tmp}"
        if [[ -e "${old_install_dir}" ]]; then
            mv "${old_install_dir}" "${INSTALL_LIB_DIR}"
        fi
        rm -rf "${temp_dir}"
        log_error "Failed to create qwen wrapper in ${INSTALL_BIN_DIR}."
        return 1
    fi

    rm -rf "${old_install_dir}"
    export PATH="${INSTALL_BIN_DIR}:${PATH}"

    create_source_json
    rm -rf "${temp_dir}"

    log_success "Qwen Code standalone archive installed successfully."
    log_info "Installed to ${INSTALL_LIB_DIR}"
}

install_npm() {
    require_node || return 1
    require_npm || return 1

    if command_exists qwen; then
        local qwen_version
        qwen_version=$(qwen --version 2>/dev/null || echo "unknown")
        log_info "Existing Qwen Code detected: ${qwen_version}"
        log_info "Upgrading to the latest version."
    fi

    local install_cmd=(
        npm
        install
        -g
        @qwen-code/qwen-code@latest
        --registry
        "${NPM_REGISTRY}"
    )

    log_info "Running: npm install -g @qwen-code/qwen-code@latest --registry ${NPM_REGISTRY}"
    if "${install_cmd[@]}"; then
        log_success "Qwen Code installed successfully."
        create_source_json
        return 0
    fi

    log_error "Failed to install Qwen Code."
    echo ""
    echo "This installer does not change your npm prefix or shell profile."
    echo "If the failure is a permission error, install Node.js with a user-owned"
    echo "Node version manager or fix your npm global package directory, then run:"
    echo "  npm install -g @qwen-code/qwen-code@latest --registry ${NPM_REGISTRY}"
    return 1
}

print_final_instructions() {
    local install_bin_dir="${1:-}"
    local installed_bin=""
    local quoted_install_bin_dir=""
    if [[ -n "${install_bin_dir}" ]]; then
        installed_bin="${install_bin_dir}/qwen"
        quoted_install_bin_dir=$(shell_quote "${install_bin_dir}")
    fi

    # PRE_INSTALL_QWENS was captured by main() BEFORE the install ran
    # (newline-separated list of every qwen binary found on disk). Filter out
    # the one we just installed; whatever remains may shadow this install.
    local other_qwens=""
    if [[ -n "${PRE_INSTALL_QWENS:-}" ]]; then
        local saved_ifs="${IFS}"
        IFS=$'\n'
        local path
        for path in ${PRE_INSTALL_QWENS}; do
            [[ -z "${path}" ]] && continue
            [[ -n "${installed_bin}" && "${path}" == "${installed_bin}" ]] && continue
            if [[ -z "${other_qwens}" ]]; then
                other_qwens="${path}"
            else
                other_qwens="${other_qwens}"$'\n'"${path}"
            fi
        done
        IFS="${saved_ifs}"
    fi

    if [[ -n "${install_bin_dir}" ]]; then
        export PATH="${install_bin_dir}:${PATH}"
    fi

    echo ""
    echo "=========================================="
    echo "Installation completed!"
    echo "=========================================="
    echo ""

    local installed_version="unknown"
    if [[ -n "${installed_bin}" && -x "${installed_bin}" ]]; then
        installed_version=$("${installed_bin}" --version 2>/dev/null || echo "unknown")
    elif command_exists qwen; then
        installed_version=$(qwen --version 2>/dev/null || echo "unknown")
    fi

    if [[ -n "${installed_bin}" ]]; then
        log_success "Installed at ${installed_bin}: ${installed_version}"
    else
        log_success "Qwen Code installed: ${installed_version}"
    fi

    if [[ -n "${other_qwens}" ]]; then
        echo ""
        log_warning "Other 'qwen' executables exist on this system. Depending on your"
        log_warning "shell PATH order, one of these may run instead of the install above:"
        local saved_ifs="${IFS}"
        IFS=$'\n'
        local path
        for path in ${other_qwens}; do
            [[ -z "${path}" ]] && continue
            log_warning "  ${path}"
        done
        IFS="${saved_ifs}"
        echo ""
        if [[ "${NO_MODIFY_PATH:-0}" == "1" ]]; then
            echo "Skipped shell rc update because --no-modify-path is set."
            echo "To make this install win, manually add to your shell rc:"
            echo "  export PATH=${quoted_install_bin_dir}:\$PATH"
        else
            maybe_update_shell_path "${install_bin_dir}"
            echo ""
            echo "If you prefer not to modify the shell rc, rerun with --no-modify-path"
            echo "and pick one of:"
            echo "  - npm uninstall -g @qwen-code/qwen-code   # if the shadow is an npm install"
            echo "  - invoke directly: ${installed_bin}"
        fi
        return 0
    fi

    if ! command_exists qwen; then
        log_warning "Qwen Code was installed, but qwen is not on PATH in this shell."
        echo ""
        echo "Restart your terminal, then run: qwen"
        if [[ -n "${install_bin_dir}" ]]; then
            echo ""
            echo "Or run this in the current shell:"
            echo "  export PATH=${quoted_install_bin_dir}:\$PATH"
            echo "  qwen"
        fi
        return 0
    fi

    echo ""
    echo "You can now run: qwen"
    echo ""
    log_info "Run qwen in your project directory to start an interactive session."
}

main() {
    if [[ -z "${HOME:-}" ]]; then
        log_error "HOME is not set; cannot determine where to install Qwen Code."
        exit 1
    fi

    # Discover all qwen executables on disk BEFORE we install, so the
    # just-installed binary doesn't pollute the search. We can't reliably
    # simulate the user's interactive shell PATH (some tools inject their
    # bin only under a tty), so we enumerate well-known per-tool bin
    # directories plus whatever bash inherited on PATH.
    PRE_INSTALL_QWENS=$(
        {
            IFS=:
            for dir in $PATH; do
                [[ -z "${dir}" ]] && continue
                [[ -x "${dir}/qwen" ]] && echo "${dir}/qwen"
            done
            for candidate in \
                "${HOME}/.opencode/bin/qwen" \
                "${HOME}/.bun/bin/qwen" \
                "${HOME}/.cargo/bin/qwen" \
                "${HOME}/.deno/bin/qwen" \
                "${HOME}/.volta/bin/qwen" \
                "${HOME}/.fnm/bin/qwen" \
                "${HOME}/.local/bin/qwen" \
                "${HOME}/Library/pnpm/qwen" \
                "/usr/local/bin/qwen" \
                "/opt/homebrew/bin/qwen"; do
                [[ -x "${candidate}" ]] && echo "${candidate}"
            done
            if command_exists npm; then
                local npm_prefix
                npm_prefix=$(npm prefix -g 2>/dev/null || true)
                if [[ -n "${npm_prefix}" && -x "${npm_prefix}/bin/qwen" ]]; then
                    echo "${npm_prefix}/bin/qwen"
                fi
            fi
        } 2>/dev/null | sort -u
    )
    export PRE_INSTALL_QWENS

    print_header

    case "${METHOD}" in
        standalone)
            install_standalone
            print_final_instructions "${INSTALL_BIN_DIR}"
            ;;
        npm)
            install_npm
            print_final_instructions "$(get_npm_global_bin)"
            ;;
        detect)
            # Try the standalone archive first; fall back only when unavailable.
            if install_standalone; then
                print_final_instructions "${INSTALL_BIN_DIR}"
            else
                standalone_status=$?
                if [[ "${standalone_status}" -eq 2 ]]; then
                    log_warning "Falling back to npm installation."
                    if install_npm; then
                        print_final_instructions "$(get_npm_global_bin)"
                    else
                        log_warning "Standalone archive was unavailable before npm fallback; npm fallback also failed."
                        log_warning "Retry with --method standalone to debug the standalone failure, or install Node.js 22+ and rerun --method npm."
                        exit 1
                    fi
                else
                    log_warning "Standalone install failed. Retry with --method npm to use npm, or --method standalone to debug the standalone failure."
                    exit "${standalone_status}"
                fi
            fi
            ;;
    esac
}

main "$@"
