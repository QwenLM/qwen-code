#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Migrate to Qwen-Code — Configuration Migration Script
# Migrates settings from Claude Code, Cursor, Gemini CLI, Continue,
# GitHub Copilot, and shared .agents/ into ~/.qwen/
# ============================================================================

QWEN_DIR="${HOME}/.qwen"
QWEN_SETTINGS="${QWEN_DIR}/settings.json"
QWEN_SKILLS="${QWEN_DIR}/skills"
QWEN_AGENTS="${QWEN_DIR}/agents"
QWEN_MD="${QWEN_DIR}/QWEN.md"
BACKUP_DIR="${QWEN_DIR}/backups/migrate-$(date +%Y%m%d-%H%M%S)"

CLAUDE_DIR="${HOME}/.claude"
CURSOR_DIR="${HOME}/.cursor"
GEMINI_DIR="${HOME}/.gemini"
CONTINUE_DIR="${HOME}/.continue"
COPILOT_DIR="${HOME}/.config/github-copilot"
AGENTS_DIR="${HOME}/.agents"

COLOR_GREEN="\033[0;32m"
COLOR_YELLOW="\033[0;33m"
COLOR_RED="\033[0;31m"
COLOR_BLUE="\033[0;34m"
COLOR_CYAN="\033[0;36m"
COLOR_RESET="\033[0m"

# ============================================================================
# Utility Functions
# ============================================================================

log_info() {
    echo -e "${COLOR_GREEN}[✓]${COLOR_RESET} $1"
}

log_warn() {
    echo -e "${COLOR_YELLOW}[!]${COLOR_RESET} $1"
}

log_error() {
    echo -e "${COLOR_RED}[✗]${COLOR_RESET} $1"
}

log_section() {
    echo ""
    echo -e "${COLOR_BLUE}━━━ $1 ━━━${COLOR_RESET}"
}

log_detail() {
    echo -e "    ${COLOR_CYAN}→${COLOR_RESET} $1"
}

ensure_qwen_dirs() {
    mkdir -p "${QWEN_DIR}" "${QWEN_SKILLS}" "${QWEN_AGENTS}"
    if [ ! -f "${QWEN_SETTINGS}" ]; then
        echo '{}' > "${QWEN_SETTINGS}"
    fi
}

create_backup() {
    mkdir -p "${BACKUP_DIR}"
    if [ -f "${QWEN_SETTINGS}" ]; then
        cp "${QWEN_SETTINGS}" "${BACKUP_DIR}/settings.json.bak"
        log_info "Backup created at ${BACKUP_DIR}/settings.json.bak"
    fi
    if [ -f "${QWEN_MD}" ]; then
        cp "${QWEN_MD}" "${BACKUP_DIR}/QWEN.md.bak"
    fi
}

# Merge MCP servers from a source JSON into ~/.qwen/settings.json
# Usage: merge_mcp_servers <source_json_file> <jq_path_to_mcpServers>
merge_mcp_servers() {
    local source_file="$1"
    local jq_path="$2"
    local source_label="$3"

    if [ ! -f "${source_file}" ]; then
        return
    fi

    # Check if python3 is available (more reliable for JSON merging)
    if command -v python3 &>/dev/null; then
        python3 - "${source_file}" "${jq_path}" "${source_label}" "${QWEN_SETTINGS}" <<'PYEOF'
import json
import sys

source_file = sys.argv[1]
jq_path = sys.argv[2]
source_label = sys.argv[3]
qwen_settings_file = sys.argv[4]

try:
    with open(source_file, 'r') as f:
        source_data = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    print(f"  Could not parse {source_file}", file=sys.stderr)
    sys.exit(0)

# Navigate jq_path like ".mcpServers" or ".experimental.modelContextProtocol.servers"
keys = [k for k in jq_path.strip('.').split('.') if k]
mcp_servers = source_data
for key in keys:
    if isinstance(mcp_servers, dict) and key in mcp_servers:
        mcp_servers = mcp_servers[key]
    else:
        mcp_servers = None
        break

if not mcp_servers or not isinstance(mcp_servers, dict):
    sys.exit(0)

try:
    with open(qwen_settings_file, 'r') as f:
        qwen_data = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    qwen_data = {}

if 'mcpServers' not in qwen_data:
    qwen_data['mcpServers'] = {}

added_count = 0
skipped_count = 0
for server_name, server_config in mcp_servers.items():
    if server_name in qwen_data['mcpServers']:
        print(f"    → Skipped MCP server '{server_name}' (already exists)")
        skipped_count += 1
    else:
        qwen_data['mcpServers'][server_name] = server_config
        print(f"    → Added MCP server '{server_name}' from {source_label}")
        added_count += 1

with open(qwen_settings_file, 'w') as f:
    json.dump(qwen_data, f, indent=2)

if added_count > 0:
    print(f"  Merged {added_count} MCP server(s) from {source_label}")
if skipped_count > 0:
    print(f"  Skipped {skipped_count} existing MCP server(s)")
PYEOF
    else
        log_warn "python3 not found — cannot merge MCP servers. Please install Python 3."
    fi
}

# Copy skills from a source directory to ~/.qwen/skills/
# Usage: copy_skills <source_skills_dir> <source_label> [--symlink]
copy_skills() {
    local source_dir="$1"
    local source_label="$2"
    local use_symlink="${3:-}"

    if [ ! -d "${source_dir}" ]; then
        return
    fi

    local copied=0
    local skipped=0

    for skill_dir in "${source_dir}"/*/; do
        [ -d "${skill_dir}" ] || continue
        local skill_name
        skill_name=$(basename "${skill_dir}")

        # Skip hidden directories
        [[ "${skill_name}" == .* ]] && continue

        local target_dir="${QWEN_SKILLS}/${skill_name}"

        if [ -e "${target_dir}" ]; then
            log_detail "Skipped skill '${skill_name}' (already exists)"
            skipped=$((skipped + 1))
            continue
        fi

        if [ "${use_symlink}" = "--symlink" ]; then
            # Check if source is already a symlink, follow it to the real path
            if [ -L "${skill_dir%/}" ]; then
                local real_path
                real_path=$(readlink -f "${skill_dir%/}" 2>/dev/null || readlink "${skill_dir%/}")
                ln -s "${real_path}" "${target_dir}"
            else
                ln -s "$(cd "${skill_dir}" && pwd)" "${target_dir}"
            fi
            log_detail "Symlinked skill '${skill_name}' from ${source_label}"
        else
            cp -R "${skill_dir}" "${target_dir}"
            log_detail "Copied skill '${skill_name}' from ${source_label}"
        fi
        copied=$((copied + 1))
    done

    if [ ${copied} -gt 0 ]; then
        log_info "Migrated ${copied} skill(s) from ${source_label}"
    fi
    if [ ${skipped} -gt 0 ]; then
        log_warn "Skipped ${skipped} existing skill(s)"
    fi
}

# Copy agents from a source directory to ~/.qwen/agents/
# Usage: copy_agents <source_agents_dir> <source_label>
copy_agents() {
    local source_dir="$1"
    local source_label="$2"

    if [ ! -d "${source_dir}" ]; then
        return
    fi

    local copied=0
    local skipped=0

    for agent_file in "${source_dir}"/*.md; do
        [ -f "${agent_file}" ] || continue
        local agent_name
        agent_name=$(basename "${agent_file}")

        local target_file="${QWEN_AGENTS}/${agent_name}"

        if [ -f "${target_file}" ]; then
            log_detail "Skipped agent '${agent_name}' (already exists)"
            skipped=$((skipped + 1))
            continue
        fi

        cp "${agent_file}" "${target_file}"
        log_detail "Copied agent '${agent_name}' from ${source_label}"
        copied=$((copied + 1))
    done

    if [ ${copied} -gt 0 ]; then
        log_info "Migrated ${copied} agent(s) from ${source_label}"
    fi
    if [ ${skipped} -gt 0 ]; then
        log_warn "Skipped ${skipped} existing agent(s)"
    fi
}

# Append custom rules/instructions to QWEN.md
# Usage: append_rules <source_file> <section_header>
append_rules() {
    local source_file="$1"
    local section_header="$2"

    if [ ! -f "${source_file}" ]; then
        return
    fi

    local content
    content=$(cat "${source_file}")

    if [ -z "${content}" ]; then
        return
    fi

    # Check if this section was already appended
    if [ -f "${QWEN_MD}" ] && grep -qF "${section_header}" "${QWEN_MD}" 2>/dev/null; then
        log_detail "Skipped '${section_header}' (already in QWEN.md)"
        return
    fi

    {
        echo ""
        echo "## ${section_header}"
        echo ""
        echo "${content}"
        echo ""
    } >> "${QWEN_MD}"

    log_detail "Appended '${section_header}' to QWEN.md"
}

# Append all rule files from a directory to QWEN.md
# Usage: append_rules_dir <source_dir> <section_prefix>
append_rules_dir() {
    local source_dir="$1"
    local section_prefix="$2"

    if [ ! -d "${source_dir}" ]; then
        return
    fi

    for rule_file in "${source_dir}"/*.md "${source_dir}"/*.txt; do
        [ -f "${rule_file}" ] || continue
        local rule_name
        rule_name=$(basename "${rule_file}" | sed 's/\.[^.]*$//')
        append_rules "${rule_file}" "${section_prefix}: ${rule_name}"
    done
}

# ============================================================================
# Scan Command — Detect all AI tool configurations
# ============================================================================

cmd_scan() {
    echo ""
    echo -e "${COLOR_BLUE}╔══════════════════════════════════════════════════════════╗${COLOR_RESET}"
    echo -e "${COLOR_BLUE}║       Migrate to Qwen-Code — Configuration Scanner      ║${COLOR_RESET}"
    echo -e "${COLOR_BLUE}╚══════════════════════════════════════════════════════════╝${COLOR_RESET}"

    local found_any=false

    # --- Claude Code ---
    log_section "Claude Code (~/.claude/)"
    if [ -d "${CLAUDE_DIR}" ]; then
        found_any=true
        if [ -d "${CLAUDE_DIR}/skills" ]; then
            local skill_count
            skill_count=$(find "${CLAUDE_DIR}/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
            local symlink_count
            symlink_count=$(find "${CLAUDE_DIR}/skills" -maxdepth 1 -mindepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
            local total=$((skill_count + symlink_count))
            if [ "${total}" -gt 0 ]; then
                log_info "Found ${total} skill(s) in ~/.claude/skills/"
                for skill in "${CLAUDE_DIR}/skills"/*/; do
                    [ -d "${skill}" ] || continue
                    log_detail "$(basename "${skill}")"
                done
            fi
        fi
        if [ -f "${CLAUDE_DIR}/settings.json" ]; then
            log_info "Found settings.json"
            if python3 -c "import json; d=json.load(open('${CLAUDE_DIR}/settings.json')); print(len(d.get('mcpServers',{})))" 2>/dev/null | grep -qv '^0$'; then
                log_detail "Contains MCP server configurations"
            fi
        else
            log_warn "No settings.json found"
        fi
    else
        log_warn "Not detected"
    fi

    # --- Cursor ---
    log_section "Cursor (~/.cursor/)"
    if [ -d "${CURSOR_DIR}" ]; then
        found_any=true
        if [ -d "${CURSOR_DIR}/skills-cursor" ]; then
            local cursor_skill_count
            cursor_skill_count=$(find "${CURSOR_DIR}/skills-cursor" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
            if [ "${cursor_skill_count}" -gt 0 ]; then
                log_info "Found ${cursor_skill_count} skill(s) in ~/.cursor/skills-cursor/"
                for skill in "${CURSOR_DIR}/skills-cursor"/*/; do
                    [ -d "${skill}" ] || continue
                    log_detail "$(basename "${skill}")"
                done
            fi
        fi
        if [ -d "${CURSOR_DIR}/rules" ]; then
            local rule_count
            rule_count=$(find "${CURSOR_DIR}/rules" -type f \( -name "*.md" -o -name "*.txt" \) 2>/dev/null | wc -l | tr -d ' ')
            if [ "${rule_count}" -gt 0 ]; then
                log_info "Found ${rule_count} rule file(s) in ~/.cursor/rules/"
            fi
        fi
        if [ -f "${CURSOR_DIR}/hooks.json" ]; then
            log_info "Found hooks.json (note: hooks cannot be auto-migrated)"
        fi
    else
        log_warn "Not detected"
    fi

    # --- Gemini CLI ---
    log_section "Gemini CLI (~/.gemini/)"
    if [ -d "${GEMINI_DIR}" ]; then
        found_any=true
        if [ -f "${GEMINI_DIR}/settings.json" ]; then
            log_info "Found settings.json"
            if python3 -c "import json; d=json.load(open('${GEMINI_DIR}/settings.json')); print(len(d.get('mcpServers',{})))" 2>/dev/null | grep -qv '^0$'; then
                log_detail "Contains MCP server configurations"
            fi
        fi
        if [ -f "${GEMINI_DIR}/GEMINI.md" ]; then
            log_info "Found GEMINI.md (custom instructions)"
        fi
    else
        log_warn "Not detected"
    fi

    # --- Continue ---
    log_section "Continue (~/.continue/)"
    if [ -d "${CONTINUE_DIR}" ]; then
        found_any=true
        if [ -f "${CONTINUE_DIR}/config.json" ]; then
            log_info "Found config.json"
            if python3 -c "
import json
d=json.load(open('${CONTINUE_DIR}/config.json'))
mcp = d.get('experimental',{}).get('modelContextProtocol',{}).get('servers',{})
if not mcp:
    mcp = d.get('mcpServers',{})
print(len(mcp))
" 2>/dev/null | grep -qv '^0$'; then
                log_detail "Contains MCP server configurations"
            fi
            if python3 -c "import json; d=json.load(open('${CONTINUE_DIR}/config.json')); print(len(d.get('models',[])))" 2>/dev/null | grep -qv '^0$'; then
                log_detail "Contains model configurations (manual migration needed)"
            fi
        fi
        if [ -d "${CONTINUE_DIR}/rules" ]; then
            local continue_rule_count
            continue_rule_count=$(find "${CONTINUE_DIR}/rules" -type f 2>/dev/null | wc -l | tr -d ' ')
            if [ "${continue_rule_count}" -gt 0 ]; then
                log_info "Found ${continue_rule_count} rule file(s)"
            fi
        fi
    else
        log_warn "Not detected"
    fi

    # --- GitHub Copilot ---
    log_section "GitHub Copilot (~/.config/github-copilot/)"
    if [ -d "${COPILOT_DIR}" ]; then
        found_any=true
        log_info "Found GitHub Copilot config directory"
        if [ -f "${COPILOT_DIR}/settings.json" ]; then
            log_detail "Contains settings.json"
        fi
    else
        log_warn "Not detected"
    fi

    # --- Shared Agents ---
    log_section "Shared Agents (~/.agents/)"
    if [ -d "${AGENTS_DIR}" ]; then
        found_any=true
        if [ -d "${AGENTS_DIR}/skills" ]; then
            local agents_skill_count
            agents_skill_count=$(find "${AGENTS_DIR}/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
            if [ "${agents_skill_count}" -gt 0 ]; then
                log_info "Found ${agents_skill_count} shared skill(s)"
                for skill in "${AGENTS_DIR}/skills"/*/; do
                    [ -d "${skill}" ] || continue
                    log_detail "$(basename "${skill}")"
                done
            fi
        fi
    else
        log_warn "Not detected"
    fi

    # --- Project-level configs (current directory) ---
    log_section "Project-level configs (current directory)"
    local project_found=false
    if [ -f ".cursorrules" ]; then
        log_info "Found .cursorrules"
        project_found=true
    fi
    if [ -f "CLAUDE.md" ]; then
        log_info "Found CLAUDE.md"
        project_found=true
    fi
    if [ -f "GEMINI.md" ]; then
        log_info "Found GEMINI.md"
        project_found=true
    fi
    if [ -d ".claude" ]; then
        log_info "Found .claude/ directory"
        project_found=true
    fi
    if [ -d ".cursor" ]; then
        log_info "Found .cursor/ directory"
        project_found=true
    fi
    if [ -f ".github/copilot-instructions.md" ]; then
        log_info "Found .github/copilot-instructions.md"
        project_found=true
    fi
    if [ "${project_found}" = false ]; then
        log_warn "No project-level AI configs found in current directory"
    fi

    # --- Summary ---
    log_section "Summary"
    if [ "${found_any}" = true ]; then
        log_info "Run 'bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate all' to migrate everything"
        log_info "Or migrate individually: migrate claude | cursor | gemini | continue | copilot | agents"
    else
        log_warn "No AI tool configurations detected"
    fi
    echo ""
}

# ============================================================================
# Migrate Commands
# ============================================================================

migrate_claude() {
    log_section "Migrating Claude Code"

    if [ ! -d "${CLAUDE_DIR}" ]; then
        log_warn "Claude Code directory not found (~/.claude/)"
        return
    fi

    # Migrate skills
    if [ -d "${CLAUDE_DIR}/skills" ]; then
        copy_skills "${CLAUDE_DIR}/skills" "Claude Code"
    fi

    # Migrate MCP servers from settings.json
    if [ -f "${CLAUDE_DIR}/settings.json" ]; then
        merge_mcp_servers "${CLAUDE_DIR}/settings.json" ".mcpServers" "Claude Code"
    fi

    log_info "Claude Code migration complete"
}

migrate_cursor() {
    log_section "Migrating Cursor"

    if [ ! -d "${CURSOR_DIR}" ]; then
        log_warn "Cursor directory not found (~/.cursor/)"
        return
    fi

    # Migrate skills from skills-cursor/
    if [ -d "${CURSOR_DIR}/skills-cursor" ]; then
        copy_skills "${CURSOR_DIR}/skills-cursor" "Cursor"
    fi

    # Migrate rules
    if [ -d "${CURSOR_DIR}/rules" ]; then
        append_rules_dir "${CURSOR_DIR}/rules" "Migrated from Cursor rules"
    fi

    log_info "Cursor migration complete"
    if [ -f "${CURSOR_DIR}/hooks.json" ]; then
        log_warn "Cursor hooks.json detected but cannot be auto-migrated (no equivalent in Qwen-Code)"
    fi
}

migrate_gemini() {
    log_section "Migrating Gemini CLI"

    if [ ! -d "${GEMINI_DIR}" ]; then
        log_warn "Gemini CLI directory not found (~/.gemini/)"
        return
    fi

    # Migrate MCP servers
    if [ -f "${GEMINI_DIR}/settings.json" ]; then
        merge_mcp_servers "${GEMINI_DIR}/settings.json" ".mcpServers" "Gemini CLI"
    fi

    # Migrate GEMINI.md custom instructions
    if [ -f "${GEMINI_DIR}/GEMINI.md" ]; then
        append_rules "${GEMINI_DIR}/GEMINI.md" "Migrated from Gemini CLI (GEMINI.md)"
    fi

    log_info "Gemini CLI migration complete"
}

migrate_continue() {
    log_section "Migrating Continue"

    if [ ! -d "${CONTINUE_DIR}" ]; then
        log_warn "Continue directory not found (~/.continue/)"
        return
    fi

    # Migrate MCP servers from config.json
    if [ -f "${CONTINUE_DIR}/config.json" ]; then
        # Continue stores MCP servers in different paths depending on version
        merge_mcp_servers "${CONTINUE_DIR}/config.json" ".mcpServers" "Continue"
        merge_mcp_servers "${CONTINUE_DIR}/config.json" ".experimental.modelContextProtocol.servers" "Continue (experimental)"
    fi

    # Migrate rules
    if [ -d "${CONTINUE_DIR}/rules" ]; then
        append_rules_dir "${CONTINUE_DIR}/rules" "Migrated from Continue rules"
    fi

    # Notify about models
    if [ -f "${CONTINUE_DIR}/config.json" ]; then
        local model_count
        model_count=$(python3 -c "import json; d=json.load(open('${CONTINUE_DIR}/config.json')); print(len(d.get('models',[])))" 2>/dev/null || echo "0")
        if [ "${model_count}" != "0" ]; then
            log_warn "Continue has ${model_count} model config(s) — these need manual migration to Qwen-Code's modelProviders"
        fi
    fi

    log_info "Continue migration complete"
}

migrate_copilot() {
    log_section "Migrating GitHub Copilot"

    if [ ! -d "${COPILOT_DIR}" ]; then
        log_warn "GitHub Copilot directory not found (~/.config/github-copilot/)"
        return
    fi

    log_info "GitHub Copilot global config detected"
    log_warn "Copilot settings are tool-specific and don't have direct equivalents in Qwen-Code"
    log_detail "Project-level copilot-instructions.md can be migrated with 'migrate-project'"

    log_info "GitHub Copilot migration complete"
}

migrate_agents() {
    log_section "Migrating Shared Agents (~/.agents/)"

    if [ ! -d "${AGENTS_DIR}" ]; then
        log_warn "Shared agents directory not found (~/.agents/)"
        return
    fi

    # Migrate shared skills via symlink to preserve cross-tool sharing
    if [ -d "${AGENTS_DIR}/skills" ]; then
        copy_skills "${AGENTS_DIR}/skills" "Shared Agents" "--symlink"
    fi

    log_info "Shared agents migration complete"
}

migrate_project() {
    log_section "Migrating Project-level Configs"

    local project_dir
    project_dir=$(pwd)
    local project_qwen_dir="${project_dir}/.qwen"

    mkdir -p "${project_qwen_dir}"

    # Migrate .cursorrules
    if [ -f "${project_dir}/.cursorrules" ]; then
        append_rules "${project_dir}/.cursorrules" "Migrated from .cursorrules"
        log_info "Migrated .cursorrules"
    fi

    # Migrate CLAUDE.md
    if [ -f "${project_dir}/CLAUDE.md" ]; then
        local project_qwen_md="${project_qwen_dir}/QWEN.md"
        if [ ! -f "${project_qwen_md}" ]; then
            touch "${project_qwen_md}"
        fi
        local section_header="Migrated from CLAUDE.md"
        if ! grep -qF "${section_header}" "${project_qwen_md}" 2>/dev/null; then
            {
                echo ""
                echo "## ${section_header}"
                echo ""
                cat "${project_dir}/CLAUDE.md"
                echo ""
            } >> "${project_qwen_md}"
            log_info "Migrated CLAUDE.md → .qwen/QWEN.md"
        else
            log_detail "CLAUDE.md already migrated"
        fi
    fi

    # Migrate GEMINI.md
    if [ -f "${project_dir}/GEMINI.md" ]; then
        local project_qwen_md="${project_qwen_dir}/QWEN.md"
        if [ ! -f "${project_qwen_md}" ]; then
            touch "${project_qwen_md}"
        fi
        local section_header="Migrated from GEMINI.md"
        if ! grep -qF "${section_header}" "${project_qwen_md}" 2>/dev/null; then
            {
                echo ""
                echo "## ${section_header}"
                echo ""
                cat "${project_dir}/GEMINI.md"
                echo ""
            } >> "${project_qwen_md}"
            log_info "Migrated GEMINI.md → .qwen/QWEN.md"
        else
            log_detail "GEMINI.md already migrated"
        fi
    fi

    # Migrate .github/copilot-instructions.md
    if [ -f "${project_dir}/.github/copilot-instructions.md" ]; then
        local project_qwen_md="${project_qwen_dir}/QWEN.md"
        if [ ! -f "${project_qwen_md}" ]; then
            touch "${project_qwen_md}"
        fi
        local section_header="Migrated from .github/copilot-instructions.md"
        if ! grep -qF "${section_header}" "${project_qwen_md}" 2>/dev/null; then
            {
                echo ""
                echo "## ${section_header}"
                echo ""
                cat "${project_dir}/.github/copilot-instructions.md"
                echo ""
            } >> "${project_qwen_md}"
            log_info "Migrated copilot-instructions.md → .qwen/QWEN.md"
        else
            log_detail "copilot-instructions.md already migrated"
        fi
    fi

    # Migrate .claude/settings.json MCP servers
    if [ -f "${project_dir}/.claude/settings.json" ]; then
        local project_settings="${project_qwen_dir}/settings.json"
        if [ ! -f "${project_settings}" ]; then
            echo '{}' > "${project_settings}"
        fi
        local original_qwen_settings="${QWEN_SETTINGS}"
        QWEN_SETTINGS="${project_settings}"
        merge_mcp_servers "${project_dir}/.claude/settings.json" ".mcpServers" "Project Claude"
        QWEN_SETTINGS="${original_qwen_settings}"
        log_info "Migrated .claude/settings.json → .qwen/settings.json"
    fi

    # Migrate .cursor/rules/
    if [ -d "${project_dir}/.cursor/rules" ]; then
        local project_qwen_md="${project_qwen_dir}/QWEN.md"
        if [ ! -f "${project_qwen_md}" ]; then
            touch "${project_qwen_md}"
        fi
        local original_qwen_md="${QWEN_MD}"
        QWEN_MD="${project_qwen_md}"
        append_rules_dir "${project_dir}/.cursor/rules" "Migrated from .cursor/rules"
        QWEN_MD="${original_qwen_md}"
        log_info "Migrated .cursor/rules/ → .qwen/QWEN.md"
    fi

    log_info "Project-level migration complete"
}

migrate_all() {
    migrate_claude
    migrate_cursor
    migrate_gemini
    migrate_continue
    migrate_copilot
    migrate_agents
}

# ============================================================================
# Verify Command
# ============================================================================

cmd_verify() {
    log_section "Verification Report"

    echo ""
    echo -e "${COLOR_CYAN}Settings (${QWEN_SETTINGS}):${COLOR_RESET}"
    if [ -f "${QWEN_SETTINGS}" ]; then
        if command -v python3 &>/dev/null; then
            python3 -c "
import json
with open('${QWEN_SETTINGS}') as f:
    d = json.load(f)
mcp = d.get('mcpServers', {})
print(f'  MCP Servers: {len(mcp)}')
for name in mcp:
    print(f'    - {name}')
providers = d.get('modelProviders', {})
total_models = sum(len(v) if isinstance(v, list) else 1 for v in providers.values())
print(f'  Model Providers: {len(providers)} ({total_models} models)')
"
        else
            log_warn "python3 not available for detailed verification"
        fi
    else
        log_warn "settings.json not found"
    fi

    echo ""
    echo -e "${COLOR_CYAN}Skills (${QWEN_SKILLS}/):${COLOR_RESET}"
    if [ -d "${QWEN_SKILLS}" ]; then
        local skill_count=0
        for skill_dir in "${QWEN_SKILLS}"/*/; do
            [ -d "${skill_dir}" ] || continue
            local sname
            sname=$(basename "${skill_dir}")
            [[ "${sname}" == .* ]] && continue
            if [ -L "${skill_dir%/}" ]; then
                log_detail "${sname} (symlink → $(readlink "${skill_dir%/}"))"
            else
                log_detail "${sname}"
            fi
            skill_count=$((skill_count + 1))
        done
        log_info "Total: ${skill_count} skill(s)"
    fi

    echo ""
    echo -e "${COLOR_CYAN}Agents (${QWEN_AGENTS}/):${COLOR_RESET}"
    if [ -d "${QWEN_AGENTS}" ]; then
        local agent_count=0
        for agent_file in "${QWEN_AGENTS}"/*.md; do
            [ -f "${agent_file}" ] || continue
            log_detail "$(basename "${agent_file}")"
            agent_count=$((agent_count + 1))
        done
        log_info "Total: ${agent_count} agent(s)"
    fi

    echo ""
    echo -e "${COLOR_CYAN}Custom Instructions (${QWEN_MD}):${COLOR_RESET}"
    if [ -f "${QWEN_MD}" ]; then
        local line_count
        line_count=$(wc -l < "${QWEN_MD}" | tr -d ' ')
        log_info "${line_count} lines"
        # Show section headers
        grep "^## " "${QWEN_MD}" 2>/dev/null | while read -r line; do
            log_detail "${line}"
        done
    else
        log_warn "QWEN.md not found"
    fi

    echo ""
    echo -e "${COLOR_CYAN}Backups:${COLOR_RESET}"
    if [ -d "${QWEN_DIR}/backups" ]; then
        local backup_count
        backup_count=$(find "${QWEN_DIR}/backups" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
        log_info "${backup_count} backup(s) in ~/.qwen/backups/"
    else
        log_detail "No backups yet"
    fi

    echo ""
}

# ============================================================================
# Main Entry Point
# ============================================================================

usage() {
    echo ""
    echo -e "${COLOR_BLUE}Migrate to Qwen-Code${COLOR_RESET}"
    echo ""
    echo "Usage: $(basename "$0") <command> [options]"
    echo ""
    echo "Commands:"
    echo "  scan              Detect all AI tool configurations"
    echo "  migrate <source>  Migrate from a specific source or 'all'"
    echo "                    Sources: claude, cursor, gemini, continue, copilot, agents, all"
    echo "  migrate-project   Migrate project-level configs (run from project root)"
    echo "  verify            Verify migration results"
    echo ""
    echo "Examples:"
    echo "  $(basename "$0") scan"
    echo "  $(basename "$0") migrate claude"
    echo "  $(basename "$0") migrate all"
    echo "  $(basename "$0") migrate-project"
    echo "  $(basename "$0") verify"
    echo ""
}

main() {
    local command="${1:-}"

    case "${command}" in
        scan)
            cmd_scan
            ;;
        migrate)
            local source="${2:-}"
            if [ -z "${source}" ]; then
                log_error "Please specify a source: claude, cursor, gemini, continue, copilot, agents, all"
                usage
                exit 1
            fi
            ensure_qwen_dirs
            create_backup
            case "${source}" in
                claude)   migrate_claude ;;
                cursor)   migrate_cursor ;;
                gemini)   migrate_gemini ;;
                continue) migrate_continue ;;
                copilot)  migrate_copilot ;;
                agents)   migrate_agents ;;
                all)      migrate_all ;;
                *)
                    log_error "Unknown source: ${source}"
                    usage
                    exit 1
                    ;;
            esac
            echo ""
            log_info "Migration complete! Run 'bash $(realpath "$0") verify' to check results."
            echo ""
            ;;
        migrate-project)
            ensure_qwen_dirs
            migrate_project
            ;;
        verify)
            cmd_verify
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            if [ -z "${command}" ]; then
                usage
            else
                log_error "Unknown command: ${command}"
                usage
                exit 1
            fi
            ;;
    esac
}

main "$@"
