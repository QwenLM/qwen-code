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
MUTED='\033[0;2m'
NC='\033[0m'
BRAND_ORANGE='\033[38;5;214m'

supports_truecolor() {
    [[ "${COLORTERM:-}" == "truecolor" || "${COLORTERM:-}" == "24bit" ]]
}

if supports_truecolor; then
    BRAND_BLUE='\033[38;2;71;150;228m'
    BRAND_PURPLE='\033[38;2;132;122;206m'
else
    BRAND_BLUE='\033[38;5;68m'
    BRAND_PURPLE='\033[38;5;140m'
fi

log_info() {
    printf '%bINFO:%b %s\n' "${BLUE}" "${NC}" "$1"
}

log_success() {
    printf '%bSUCCESS:%b %s\n' "${GREEN}" "${NC}" "$1"
}

log_warning() {
    printf '%bWARNING:%b %s\n' "${YELLOW}" "${NC}" "$1"
}

log_error() {
    printf '%bERROR:%b %s\n' "${RED}" "${NC}" "$1" >&2
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

is_terminal() {
    [ -t 2 ]
}

print_progress() {
    local bytes="$1"
    local length="$2"
    [ "$length" -gt 0 ] || return 0
    local width=50
    local percent=$(( bytes * 100 / length ))
    [ "$percent" -gt 100 ] && percent=100
    local on=$(( percent * width / 100 ))
    local off=$(( width - on ))
    local filled=$(printf "%*s" "$on" "")
    filled=${filled// /■}
    local empty=$(printf "%*s" "$off" "")
    empty=${empty// /･}
    printf "\r${BRAND_ORANGE}%s%s %3d%%${NC}" "$filled" "$empty" "$percent" >&2
}

finish_progress() {
    print_progress 1 1
    echo "" >&2
}

TEMP_DIRS=()
ACTIVE_DOWNLOAD_PID=""
PATH_UPDATE_APPLIED=0

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

restore_cursor() {
    printf "\033[?25h"
}

kill_active_download() {
    if [[ -n "${ACTIVE_DOWNLOAD_PID}" ]]; then
        kill "${ACTIVE_DOWNLOAD_PID}" 2>/dev/null || true
        ACTIVE_DOWNLOAD_PID=""
    fi
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

display_install_version() {
    if [[ "${VERSION}" == "latest" ]]; then
        echo "latest"
        return 0
    fi

    echo "${VERSION#v}"
}

trap cleanup_temp_dirs EXIT
trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 130' INT
trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 143' TERM

print_usage() {
    cat <<EOF
Qwen Code Installer

Usage: $0 [OPTIONS]

Options:
  --method METHOD      Install method: detect, standalone, or npm (default: detect)
  --mirror MIRROR      Mirror: auto, github, or aliyun (default: auto)
  --base-url URL       Override standalone archive base URL
  --archive PATH       Install from a local standalone archive
  --version VERSION    Release version (default: latest)
  --registry URL       npm registry (default: https://registry.npmmirror.com)
  --no-modify-path     Do not modify shell rc file
  -s, --source SOURCE  Record installation source
  -h, --help           Show this help message

Example:
  curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
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
    echo ""
    echo "Installing Qwen Code version: $(display_install_version)"
    echo ""
}

print_node_help() {
    echo ""
    echo "Node.js 22 or newer is required. Install from https://nodejs.org/ then rerun."
    echo "  brew install node"
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
}

require_npm() {
    if command_exists npm; then
        return 0
    fi

    log_error "npm was not found. Install Node.js with npm from https://nodejs.org/"
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

get_npm_global_root() {
    npm root -g 2>/dev/null || true
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
        *)
            log_warning "Unsupported shell for automatic PATH update: ${SHELL:-unknown}. Add ${install_bin_dir} to PATH manually."
            return 0
            ;;
    esac

    [[ -z "${rc_file}" ]] && return 0

    local begin_marker="# Qwen Code PATH block begin"
    local end_marker="# Qwen Code PATH block end"
    local quoted_install_bin_dir
    quoted_install_bin_dir=$(shell_quote "${install_bin_dir}")
    local export_line
    if [[ "${rc_file}" == *config.fish ]]; then
        export_line="set -gx PATH ${quoted_install_bin_dir} \$PATH"
    else
        export_line="export PATH=${quoted_install_bin_dir}:\$PATH"
    fi

    if [[ -f "${rc_file}" ]] && grep -qxF "${export_line}" "${rc_file}" 2>/dev/null; then
        local current_tail
        current_tail=$(tail -n 3 "${rc_file}" 2>/dev/null || true)
        if [[ "${current_tail}" == "${begin_marker}"$'\n'"${export_line}"$'\n'"${end_marker}" ]]; then
            PATH_UPDATE_APPLIED=1
            return 0
        fi
    fi

    mkdir -p "$(dirname "${rc_file}")" 2>/dev/null || true
    {
        echo ""
        echo "${begin_marker}"
        echo "${export_line}"
        echo "${end_marker}"
    } >> "${rc_file}" || {
        log_warning "Could not write PATH update to ${rc_file}."
        return 0
    }

    PATH_UPDATE_APPLIED=1
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

aliyun_latest_version_url() {
    echo "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/latest/VERSION"
}

normalize_version_path_value() {
    local raw_version="$1"
    local version_path

    raw_version=$(printf '%s' "${raw_version}" | tr -d '\r' | awk 'NF { print $1; exit }')
    if [[ -z "${raw_version}" ]]; then
        return 1
    fi

    case "${raw_version}" in
        v*)
            version_path="${raw_version}"
            ;;
        *)
            version_path="v${raw_version}"
            ;;
    esac

    if [[ "${version_path}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$ ]]; then
        echo "${version_path}"
        return 0
    fi

    return 1
}

download_text() {
    local url="$1"

    if command_exists curl; then
        curl -fsSL --retry 2 --connect-timeout 10 --max-time 30 "${url}"
        return $?
    fi

    if command_exists wget; then
        local wget_args=(--tries=3 --timeout=10)
        if wget --help 2>&1 | grep -q -- '--read-timeout'; then
            wget_args+=(--read-timeout=30)
        fi
        wget -q "${wget_args[@]}" -O - "${url}"
        return $?
    fi

    log_error "curl or wget is required to resolve the standalone release version."
    return 1
}

resolve_aliyun_version_path() {
    local version_path="$1"

    if [[ "${version_path}" != "latest" ]]; then
        echo "${version_path}"
        return 0
    fi

    local latest_url
    latest_url=$(aliyun_latest_version_url)

    local latest_version
    if ! latest_version=$(download_text "${latest_url}"); then
        log_warning "Failed to resolve Aliyun latest VERSION pointer." >&2
        return 1
    fi

    local resolved_version_path
    if ! resolved_version_path=$(normalize_version_path_value "${latest_version}"); then
        log_error "Aliyun latest VERSION pointer is not a valid semver value."
        return 1
    fi

    : # resolved to ${resolved_version_path}
    echo "${resolved_version_path}"
}

# Probe a URL with a HEAD request first, then fall back to a 1-byte ranged GET
# for object stores or CDNs that reject HEAD while still serving the object.
probe_url_available() {
    local url="$1"
    local timeout="${2:-30}"

    if command_exists curl; then
        if curl -fsIL --retry 1 --connect-timeout 10 --max-time "${timeout}" "${url}" >/dev/null 2>&1; then
            return 0
        fi
        curl -fsL --retry 1 --connect-timeout 10 --max-time "${timeout}" \
            --range 0-0 -o /dev/null "${url}" >/dev/null 2>&1
        return $?
    fi

    if command_exists wget; then
        local wget_args=(--tries=2 --timeout=10)
        if wget --help 2>&1 | grep -q -- '--read-timeout'; then
            wget_args+=(--read-timeout="${timeout}")
        fi
        if wget -q --spider "${wget_args[@]}" "${url}" >/dev/null 2>&1; then
            return 0
        fi
        wget -q "${wget_args[@]}" --header='Range: bytes=0-0' -O /dev/null "${url}" >/dev/null 2>&1
        return $?
    fi

    return 1
}

# Race two availability probes; print "aliyun" or "github" based on which
# mirror's SHA256SUMS responds first, or "timeout" if neither responds before
# the deadline. Caller decides what to do with "timeout" (currently: log it and
# fall back to github).
race_mirror_head() {
    local timeout="${1:-2}"
    local gh_url="$2"
    local oss_url="$3"
    local tmpdir
    if ! tmpdir=$(mktemp -d -t qwen-mirror.XXXXXX 2>/dev/null); then
        # Refuse to fall back to a predictable PID-based path; a local attacker
        # could pre-create it to influence mirror selection.
        echo "mirror probe: mktemp failed" >&2
        echo "github"
        return 0
    fi
    register_temp_dir "${tmpdir}"

    (probe_url_available "${oss_url}" "${timeout}" && : > "${tmpdir}/aliyun") &
    local oss_pid=$!
    (probe_url_available "${gh_url}" "${timeout}" && : > "${tmpdir}/github") &
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
        if [[ "${version_path}" == "latest" ]]; then
            oss_head="$(aliyun_latest_version_url)"
        else
            oss_head="$(aliyun_base_url_for_version "${version_path}")/SHA256SUMS"
        fi
        selected=$(race_mirror_head 2 "${gh_head}" "${oss_head}")
        if [[ "${selected}" == "timeout" ]]; then
            selected="github"
        fi
        MIRROR="${selected}"
    fi

    if [[ "${MIRROR}" == "aliyun" ]]; then
        if ! version_path=$(resolve_aliyun_version_path "${version_path}"); then
            return 1
        fi
        aliyun_base_url_for_version "${version_path}"
        return 0
    fi

    github_base_url_for_version "${version_path}"
}

get_content_length() {
    local url="$1"
    curl -fsSLI --retry 1 --connect-timeout 10 --max-time 15 "${url}" 2>/dev/null \
        | grep -i '^content-length:' | tail -1 | tr -d '\r' | awk '{print $2}'
}

download_with_progress() {
    local url="$1"
    local output="$2"

    if ! command_exists curl || ! is_terminal; then
        download_file_simple "$url" "$output"
        return $?
    fi

    local content_length
    content_length=$(get_content_length "${url}")

    if [[ -z "${content_length}" ]] || [[ "${content_length}" -le 0 ]] 2>/dev/null; then
        download_file_simple "$url" "$output"
        return $?
    fi

    # Skip progress bar for small files (e.g. SHA256SUMS)
    if [[ "${content_length}" -lt 102400 ]] 2>/dev/null; then
        curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "${url}" -o "${output}"
        return $?
    fi

    printf "\033[?25l" >&2
    print_progress 0 "${content_length}"

    curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "${url}" -o "${output}" &
    ACTIVE_DOWNLOAD_PID=$!

    while kill -0 "${ACTIVE_DOWNLOAD_PID}" 2>/dev/null; do
        if [[ -f "${output}" ]]; then
            local file_size
            file_size=$(wc -c < "${output}" 2>/dev/null | tr -d ' ')
            if [[ -n "${file_size}" && "${file_size}" -gt 0 ]] 2>/dev/null; then
                print_progress "${file_size}" "${content_length}"
            fi
        fi
        sleep 1
    done

    wait "${ACTIVE_DOWNLOAD_PID}"
    local exit_code=$?
    ACTIVE_DOWNLOAD_PID=""
    printf "\033[?25h" >&2

    if [[ $exit_code -eq 0 ]]; then
        finish_progress
    else
        echo "" >&2
    fi
    return $exit_code
}

download_file_simple() {
    local url="$1"
    local destination="$2"

    if command_exists curl; then
        curl -fL --retry 2 --connect-timeout 15 --max-time 300 --progress-bar "${url}" -o "${destination}"
        return $?
    fi

    if command_exists wget; then
        local wget_args=(--tries=3 --timeout=15)
        if wget --help 2>&1 | grep -q -- '--read-timeout'; then
            wget_args+=(--read-timeout=300)
        fi
        if wget --help 2>&1 | grep -q -- '--progress'; then
            wget --progress=bar:force:noscroll "${wget_args[@]}" "${url}" -O "${destination}" &
            ACTIVE_DOWNLOAD_PID=$!
            wait "${ACTIVE_DOWNLOAD_PID}"
            local exit_code=$?
            ACTIVE_DOWNLOAD_PID=""
            return "${exit_code}"
        else
            wget "${wget_args[@]}" "${url}" -O "${destination}" &
            ACTIVE_DOWNLOAD_PID=$!
            wait "${ACTIVE_DOWNLOAD_PID}"
            local exit_code=$?
            ACTIVE_DOWNLOAD_PID=""
            return "${exit_code}"
        fi
    fi

    log_error "curl or wget is required to download the standalone archive."
    return 1
}

download_file() {
    local url="$1"
    local destination="$2"

    download_with_progress "${url}" "${destination}"
}

url_exists() {
    local url="$1"

    probe_url_available "${url}" 30
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
        log_error "SHA256SUMS not found at ${checksum_file}; cannot verify archive."
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
        log_error "Checksum mismatch for ${archive_name}: expected ${expected}, got ${actual}."
        return 1
    fi
}

validate_archive_entry_path() {
    local entry="$1"
    entry="${entry//\\//}"

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
        ""|/*|..|../*|*/..|*/../*)
            log_error "Archive contains unsafe path: ${entry:-<empty>}"
            return 1
            ;;
    esac
}

archive_contains_symlinks_or_hardlinks() {
    local archive_path="$1"

    case "${archive_path}" in
        *.zip)
            unzip -Z -v "${archive_path}" 2>/dev/null | grep -E 'Unix file attributes \(12[0-7]{4} octal\)' >/dev/null
            ;;
        *.tar.gz|*.tgz|*.tar.xz)
            tar -tvf "${archive_path}" 2>/dev/null | awk '$1 ~ /^[lh]/ { found=1 } END { exit found ? 0 : 1 }'
            ;;
        *)
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

    if [[ -z "${entries}" ]]; then
        log_error "Archive is empty: ${archive_path}"
        return 1
    fi

    if archive_contains_symlinks_or_hardlinks "${archive_path}"; then
        log_error "Archive contains symlinks or hardlinks; refusing to install."
        return 1
    fi

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

    local backup="${install_dir}.backup.$(date +%Y%m%dT%H%M%S 2>/dev/null || date +%Y%m%d%H%M%S)"
    log_warning "${install_dir} exists but is not a Qwen Code standalone install."
    log_warning "Backing up to: ${backup}"
    if mv "${install_dir}" "${backup}"; then
        return 0
    fi

    log_error "Failed to back up ${install_dir}. Move or remove it manually, then rerun the installer."
    return 1
}

restore_stale_install_backup() {
    local old_install_dir="$1"
    local current_install_dir="$2"

    if [[ -e "${current_install_dir}" || ! -e "${old_install_dir}" ]]; then
        return 0
    fi

    log_warning "Found previous install backup without an active install: ${old_install_dir}"
    log_warning "Restoring backup to ${current_install_dir} before continuing."
    if mv "${old_install_dir}" "${current_install_dir}"; then
        return 0
    fi

    log_error "Failed to restore previous install from ${old_install_dir}."
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

    if ! cat > "${wrapper_path}" <<EOF
#!/usr/bin/env sh
exec ${quoted_qwen_bin} "\$@"
EOF
    then
        return 1
    fi
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

        local requested_mirror="${MIRROR}"
        local requested_version_path=""
        local github_fallback_base_url=""
        if [[ -z "${BASE_URL}" && "${requested_mirror}" == "auto" ]]; then
            requested_version_path=$(release_version_path)
            github_fallback_base_url="$(github_base_url_for_version "${requested_version_path}")"
        fi

        local base_url
        if ! base_url=$(standalone_base_url); then
            if [[ -n "${github_fallback_base_url}" ]]; then
                log_warning "Aliyun standalone release metadata unavailable; retrying GitHub mirror."
                base_url="${github_fallback_base_url}"
                MIRROR="github"
                github_fallback_base_url=""
            else
                if [[ "${METHOD}" == "detect" ]]; then
                    return 2
                fi
                return 1
            fi
        fi
        if [[ -n "${github_fallback_base_url}" && "${requested_version_path}" == "latest" ]]; then
            local aliyun_release_base="https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/"
            if [[ "${base_url}" == "${aliyun_release_base}"* ]]; then
                local resolved_version_path="${base_url#"${aliyun_release_base}"}"
                if [[ -n "${resolved_version_path}" && "${resolved_version_path}" != "latest" && "${resolved_version_path}" != */* ]]; then
                    github_fallback_base_url="$(github_base_url_for_version "${resolved_version_path}")"
                fi
            fi
        fi
        if [[ "${base_url}" == "${github_fallback_base_url}" ]]; then
            github_fallback_base_url=""
        fi

        local archive_url="${base_url}/${archive_name}"
        checksum_source="${base_url}/SHA256SUMS"

        if [[ "${METHOD}" == "detect" ]] && ! url_exists "${archive_url}"; then
            if [[ -n "${github_fallback_base_url}" ]]; then
                local github_archive_url="${github_fallback_base_url}/${archive_name}"
                if url_exists "${github_archive_url}"; then
                    log_warning "Aliyun standalone archive not found; retrying GitHub mirror."
                    base_url="${github_fallback_base_url}"
                    archive_url="${github_archive_url}"
                    checksum_source="${base_url}/SHA256SUMS"
                    MIRROR="github"
                    github_fallback_base_url=""
                else
                    log_warning "Standalone archive not found: ${archive_name}"
                    return 2
                fi
            else
                log_warning "Standalone archive not found: ${archive_name}"
                return 2
            fi
        fi

        temp_dir=$(mktemp -d)
        register_temp_dir "${temp_dir}"
        archive_path="${temp_dir}/${archive_name}"

        log_info "Downloading ${archive_name}"
        if ! download_file "${archive_url}" "${archive_path}"; then
            if [[ -n "${github_fallback_base_url}" ]]; then
                rm -f "${archive_path}"
                archive_url="${github_fallback_base_url}/${archive_name}"
                checksum_source="${github_fallback_base_url}/SHA256SUMS"
                MIRROR="github"
                github_fallback_base_url=""
                log_warning "Aliyun standalone archive download failed; retrying GitHub mirror."
                if download_file "${archive_url}" "${archive_path}"; then
                    :
                else
                    rm -rf "${temp_dir}"
                    log_warning "Failed to download standalone archive."
                    if [[ "${METHOD}" == "detect" ]]; then
                        return 2
                    fi
                    return 1
                fi
            else
                rm -rf "${temp_dir}"
                log_warning "Failed to download standalone archive."
                if [[ "${METHOD}" == "detect" ]]; then
                    return 2
                fi
                return 1
            fi
        fi
    fi

    if [[ -z "${temp_dir}" ]]; then
        temp_dir=$(mktemp -d)
        register_temp_dir "${temp_dir}"
    fi

    if ! verify_checksum "${archive_path}" "${checksum_source}" "${archive_name}"; then
        rm -rf "${temp_dir}"
        return 1
    fi

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
    if ! restore_stale_install_backup "${old_install_dir}" "${INSTALL_LIB_DIR}"; then
        rm -rf "${temp_dir}"
        return 1
    fi
    if [[ -e "${old_install_dir}" ]]; then
        rm -rf "${old_install_dir}" || {
            rm -rf "${temp_dir}"
            log_error "Failed to remove stale install backup: ${old_install_dir}"
            return 1
        }
    fi
    rm -rf "${new_install_dir}" "${wrapper_tmp}"
    mv "${extract_dir}/qwen-code" "${new_install_dir}"

    if ! write_unix_wrapper "${wrapper_tmp}" "${INSTALL_LIB_DIR}/bin/qwen"; then
        rm -rf "${temp_dir}" "${new_install_dir}" "${wrapper_tmp}"
        log_error "Failed to create qwen wrapper in ${INSTALL_BIN_DIR}."
        return 1
    fi

    # Suppress INT/TERM during the critical mv swap to avoid leaving
    # INSTALL_LIB_DIR absent if the user presses Ctrl+C between the two moves.
    trap '' INT TERM
    if [[ -e "${INSTALL_LIB_DIR}" ]]; then
        mv "${INSTALL_LIB_DIR}" "${old_install_dir}"
    fi

    if ! mv "${new_install_dir}" "${INSTALL_LIB_DIR}"; then
        if [[ -e "${old_install_dir}" ]]; then
            mv "${old_install_dir}" "${INSTALL_LIB_DIR}"
        fi
        trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 130' INT
        trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 143' TERM
        rm -rf "${temp_dir}" "${wrapper_tmp}"
        log_error "Failed to install standalone archive to ${INSTALL_LIB_DIR}."
        return 1
    fi
    trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 130' INT
    trap 'restore_cursor >&2; kill_active_download; cleanup_temp_dirs; exit 143' TERM

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
}

npm_package_spec() {
    if [[ "${VERSION}" == "latest" ]]; then
        echo "@qwen-code/qwen-code@latest"
        return 0
    fi

    local npm_version="${VERSION#v}"
    echo "@qwen-code/qwen-code@${npm_version}"
}

install_npm() {
    require_node || return 1
    require_npm || return 1

    local package_spec
    package_spec=$(npm_package_spec)

    local install_cmd=(
        npm
        install
        -g
        "${package_spec}"
        --registry
        "${NPM_REGISTRY}"
    )

    if "${install_cmd[@]}"; then
        create_source_json
        return 0
    fi

    log_error "Failed to install. Try: npm install -g ${package_spec} --registry ${NPM_REGISTRY}"
    return 1
}

gradient_line() {
    local text="$1"
    local r1=$2 g1=$3 b1=$4
    local r2=$5 g2=$6 b2=$7
    local r3=$8 g3=$9 b3=${10}
    local len=${#text}
    [ "$len" -eq 0 ] && return
    if ! supports_truecolor; then
        printf "%b%s%b\n" "${BRAND_PURPLE}" "${text}" "${NC}"
        return
    fi
    local i=0
    local half=$(( len / 2 ))
    while [ $i -lt $len ]; do
        local char="${text:$i:1}"
        local r g b
        if [ $i -lt $half ]; then
            local t=$(( i * 1000 / half ))
            r=$(( (r1 * (1000 - t) + r2 * t) / 1000 ))
            g=$(( (g1 * (1000 - t) + g2 * t) / 1000 ))
            b=$(( (b1 * (1000 - t) + b2 * t) / 1000 ))
        else
            local t=$(( (i - half) * 1000 / (len - half) ))
            r=$(( (r2 * (1000 - t) + r3 * t) / 1000 ))
            g=$(( (g2 * (1000 - t) + g3 * t) / 1000 ))
            b=$(( (b2 * (1000 - t) + b3 * t) / 1000 ))
        fi
        if [ "$char" = " " ]; then
            printf " "
        else
            printf "\033[38;2;%d;%d;%dm%s" "$r" "$g" "$b" "$char"
        fi
        i=$(( i + 1 ))
    done
    printf "\033[0m\n"
}

print_logo() {
    # Per-character gradient matching CLI's ink-gradient rendering
    # Direction: #4796E4 (blue) → #847ACE (purple) → #C3677F (rose)
    gradient_line " ▄▄▄▄▄▄  ▄▄     ▄▄ ▄▄▄▄▄▄▄ ▄▄▄    ▄▄"  71 150 228  132 122 206  195 103 127
    gradient_line "██╔═══██╗██║    ██║██╔════╝████╗  ██║"  71 150 228  132 122 206  195 103 127
    gradient_line "██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║"  71 150 228  132 122 206  195 103 127
    gradient_line "██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║"  71 150 228  132 122 206  195 103 127
    gradient_line "╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║"  71 150 228  132 122 206  195 103 127
    gradient_line " ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝"  71 150 228  132 122 206  195 103 127
}

print_final_instructions() {
    local install_bin_dir="${1:-}"
    local install_dir="${2:-}"
    local install_method="${3:-standalone}"
    local installed_bin=""
    local standalone_uninstall_url="https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/uninstall-qwen-standalone.sh"
    if [[ -n "${install_bin_dir}" ]]; then
        installed_bin="${install_bin_dir}/qwen"
        export PATH="${install_bin_dir}:${PATH}"
    fi

    # Detect shadowing qwen executables
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

    if [[ -n "${install_bin_dir}" && "${NO_MODIFY_PATH:-0}" != "1" ]]; then
        PATH_UPDATE_APPLIED=0
        maybe_update_shell_path "${install_bin_dir}"
    fi

    local installed_version="unknown"
    if [[ -n "${installed_bin}" && -x "${installed_bin}" ]]; then
        installed_version=$("${installed_bin}" --version 2>/dev/null || echo "unknown")
    elif command_exists qwen; then
        installed_version=$(qwen --version 2>/dev/null || echo "unknown")
    fi

    local rc_name=""
    case "${SHELL:-}" in
        */zsh)  rc_name="~/.zshrc" ;;
        */bash) rc_name="~/.bashrc" ;;
        */fish) rc_name="~/.config/fish/config.fish" ;;
    esac
    if [[ "${PATH_UPDATE_APPLIED:-0}" == "1" && -n "${rc_name}" ]]; then
        echo -e "${MUTED}Successfully added${NC} qwen ${MUTED}to \$PATH in${NC} ${rc_name}"
    fi

    echo ""
    echo -e "${MUTED}Qwen Code ${installed_version} installed successfully, to start:${NC}"
    echo ""
    echo -e "cd <project>  ${MUTED}# Open directory${NC}"
    echo -e "qwen          ${MUTED}# Run command${NC}"
    echo ""
    echo -e "${MUTED}For more information visit ${NC}https://qwenlm.github.io/qwen-code"
    echo ""
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
            print_final_instructions "${INSTALL_BIN_DIR}" "${INSTALL_LIB_DIR}" "standalone"
            ;;
        npm)
            install_npm
            print_final_instructions "$(get_npm_global_bin)" "$(get_npm_global_root)" "npm"
            ;;
        detect)
            if install_standalone; then
                print_final_instructions "${INSTALL_BIN_DIR}" "${INSTALL_LIB_DIR}" "standalone"
            else
                standalone_status=$?
                if [[ "${standalone_status}" -eq 2 ]]; then
                    log_warning "Falling back to npm installation."
                    if install_npm; then
                        print_final_instructions "$(get_npm_global_bin)" "$(get_npm_global_root)" "npm"
                    else
                        log_error "Standalone archive was unavailable; npm fallback also failed."
                        exit 1
                    fi
                else
                    log_error "Standalone install failed. Retry with --method npm to use npm, or --method standalone to debug."
                    exit "${standalone_status}"
                fi
            fi
            ;;
    esac
}

main "$@"
