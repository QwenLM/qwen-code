from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / 'uninstall.sh'
SOURCE = SCRIPT.read_text(encoding='utf-8')


def _function(name: str) -> str:
    start = SOURCE.index(f'{name}() {{\n')
    return SOURCE[start:SOURCE.index('\n}\n', start) + 3]


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
    path.chmod(0o755)
    return path


def _clean(config: Path, *payloads: Path, path: str | None = None):
    env = os.environ.copy()
    env['CLAUDE_JSON'] = str(config)
    if path is not None:
        env['PATH'] = path
    # Only extract the production helper. Never source or execute uninstall.sh.
    return subprocess.run(
        ['/bin/bash', '-c', 'set -euo pipefail\n' +
         _function('claude_release_config') + '\nclaude_release_config "$@"',
         'ownership-fixture', *(str(p) for p in payloads)],
        env=env, text=True, capture_output=True, check=False,
    )


def test_removes_only_live_absolute_owned_commands(tmp_path: Path) -> None:
    payload = tmp_path / 'release/packages'
    owned = _executable(payload / 'releases/v1/qwen-cua-driver')
    launcher = tmp_path / 'bin/qwen-cua-driver'
    launcher.parent.mkdir()
    launcher.symlink_to(owned)
    foreign = _executable(tmp_path / 'foreign/server')
    prefix = _executable(tmp_path / 'release/packages-other/server')
    local = _executable(tmp_path / 'local/packages/qwen-cua-driver-local')
    custom = _executable(tmp_path / 'release/custom-server')
    dangling = tmp_path / 'dangling-qwen-cua-driver-rs'
    dangling.symlink_to(payload / 'missing')
    nonexec = payload / 'readme'
    nonexec.write_text('not executable', encoding='utf-8')
    escape = payload / 'escape'
    escape.symlink_to(foreign)
    servers = {
        'owned-any-name': {'command': str(owned)},
        'canonical-launcher': {'command': str(launcher)},
        'qwen-cua-driver-rs': {'command': str(foreign)},
        'arg-substring': {'command': str(foreign), 'args': [str(owned)]},
        'legacy-arg': {'command': str(foreign), 'args': ['qwen-cua-driver-rs']},
        'prefix': {'command': str(prefix)},
        'relative': {'command': 'qwen-cua-driver-rs'},
        'relative-owned': {'command': os.path.relpath(owned)},
        'dangling': {'command': str(dangling)},
        'nonexistent-parent': {'command': str(payload / 'missing/../releases/v1/qwen-cua-driver')},
        'local': {'command': str(local)},
        'custom-home': {'command': str(custom)},
        'escape': {'command': str(escape)},
        'non-executable': {'command': str(nonexec)},
        'directory': {'command': str(payload)},
        'url': {'url': 'http://localhost:1234'},
    }
    config = tmp_path / 'claude.json'
    data = {'mcpServers': servers, 'projects': {'fixture': {
        'mcpServers': {'owned-project': {'command': str(owned)},
                       'foreign-project': {'command': str(foreign)}}}}, 'keep': '原样'}
    original = json.dumps(data, ensure_ascii=False).encode('utf-8') + b'\n\n'
    config.write_bytes(original)
    result = _clean(config, payload)
    assert result.returncode == 0, result.stderr
    actual = json.loads(config.read_bytes())
    assert set(actual['mcpServers']) == set(servers) - {'owned-any-name', 'canonical-launcher'}
    assert actual['projects']['fixture']['mcpServers'] == {'foreign-project': {'command': str(foreign)}}
    assert actual['keep'] == data['keep']
    backups = list(tmp_path.glob('claude.json.bak-cua-driver-rs-uninstall-*'))
    assert len(backups) == 1 and backups[0].read_bytes() == original
    assert owned.exists() and foreign.exists() and launcher.is_symlink()


@pytest.mark.parametrize('kind', ['final-symlink', 'missing', 'file'])
def test_unremoved_payload_targets_never_grant_ownership(tmp_path: Path, kind: str) -> None:
    target = tmp_path / 'other-install'
    command = _executable(target / 'server')
    payload = tmp_path / 'payload'
    if kind == 'final-symlink':
        payload.symlink_to(target, target_is_directory=True)
    elif kind == 'file':
        payload.write_text('file', encoding='utf-8')
    config = tmp_path / 'claude.json'
    original = json.dumps({'mcpServers': {'qwen-cua-driver-rs': {'command': str(command)}}}).encode()
    config.write_bytes(original)
    result = _clean(config, payload)
    assert result.returncode == 0, result.stderr
    assert config.read_bytes() == original
    assert not list(tmp_path.glob('*.bak-*'))


def test_parent_symlink_is_traversed_but_dotdot_uses_original_path(tmp_path: Path) -> None:
    release = tmp_path / 'real/release'
    command = _executable(release / 'packages/server')
    alias = tmp_path / 'alias'
    alias.symlink_to(release, target_is_directory=True)
    outside = tmp_path / 'outside/nested'
    outside.mkdir(parents=True)
    (release / 'packages/jump').symlink_to(outside, target_is_directory=True)
    # Lexical collapse would wrongly resolve to the owned server. Native path
    # resolution follows jump before .., so it refers to the external server.
    foreign = _executable(tmp_path / 'outside/server')
    tricky = str(release / 'packages/jump/../server')
    config = tmp_path / 'claude.json'
    config.write_text(json.dumps({'mcpServers': {
        'owned': {'command': str(command)}, 'external-dotdot': {'command': tricky},
    }}))
    result = _clean(config, alias / 'packages')
    assert result.returncode == 0, result.stderr
    assert set(json.loads(config.read_text())['mcpServers']) == {'external-dotdot'}
    assert foreign.exists()


@pytest.mark.parametrize('content', ['{', '[]', 'null'])
def test_invalid_config_fails_without_modification(tmp_path: Path, content: str) -> None:
    config = tmp_path / 'claude.json'
    config.write_text(content)
    result = _clean(config, tmp_path / 'payload')
    assert result.returncode != 0
    assert config.read_text() == content
    assert not list(tmp_path.glob('*.bak-*'))


def test_missing_python_refuses_existing_config_and_missing_config_is_noop(tmp_path: Path) -> None:
    config = tmp_path / 'claude.json'
    assert _clean(config, path=str(tmp_path)).returncode == 0
    config.write_text('{}')
    result = _clean(config, path=str(tmp_path))
    assert result.returncode != 0 and 'python3 is required' in result.stderr
    assert config.read_text() == '{}'


def test_exact_payload_selection_and_physical_parent_freezing(tmp_path: Path) -> None:
    # Execute only the production plan + its two helpers against explicit paths.
    start = SOURCE.index('    # Select executable-bearing removals once;')
    plan = SOURCE[start:SOURCE.index('    # --- CLI symlink ---', start)]
    assert 'CLAUDE_JSON="$HOME/.claude.json"' in plan
    assert 'rm ' not in plan
    real = tmp_path / 'release'
    (real / 'packages').mkdir(parents=True)
    alias = tmp_path / 'alias'
    alias.symlink_to(real, target_is_directory=True)
    legacy = tmp_path / 'legacy'
    (legacy / 'packages').mkdir(parents=True)
    app = tmp_path / 'app'
    app.mkdir()
    legacy_app = tmp_path / 'legacy-app'
    legacy_app.mkdir()
    for os_name, marker, purge, expected in [
        ('Linux', '1', '0', ['', '', str(real / 'packages'), str(legacy / 'packages')]),
        ('Darwin', '0', '0', ['', str(legacy_app), '', str(legacy / 'packages')]),
        ('Darwin', '1', '1', [str(app), str(legacy_app), str(alias), str(legacy)]),
    ]:
        env = os.environ.copy()
        env.update(OS=os_name, RUST_INSTALL_PRESENT=marker, PURGE_DATA=purge,
                   HOME_DIR=str(alias), PACKAGES_DIR=str(alias / 'packages'),
                   LEGACY_HOME_DIR=str(legacy), APP_BUNDLE=str(app),
                   LEGACY_APP_BUNDLE=str(legacy_app))
        # The plan's fixed config path is replaced only in this extracted fixture.
        fixture_plan = plan.replace('CLAUDE_JSON="$HOME/.claude.json"',
                                    'CLAUDE_JSON="$FIXTURE_CONFIG"')
        env['FIXTURE_CONFIG'] = str(tmp_path / 'absent-config')
        result = subprocess.run(['/bin/bash', '-c', 'set -euo pipefail\n' +
            _function('claude_release_config') + _function('prepare_payload_operand') +
            fixture_plan + '\nprintf "%s\\n" "$APP_PAYLOAD" "$LEGACY_APP_PAYLOAD" "$HOME_PAYLOAD" "$LEGACY_HOME_PAYLOAD"'],
            env=env, text=True, capture_output=True, check=False)
        assert result.returncode == 0, result.stderr
        assert result.stdout.splitlines() == expected
    assert real.exists() and app.exists()


def test_runtime_order_and_bash_parseability() -> None:
    rust = SOURCE[:SOURCE.index('\nUSER_BIN_LINK=', SOURCE.index('    # --- Closing message ---'))]
    proof = rust.index('    claude_release_config "$APP_PAYLOAD"')
    assert proof < rust.index('    # --- CLI symlink ---')
    assert 'claude mcp remove' not in rust
    for operand in ('"$PAYLOAD"', '"$HOME_PAYLOAD"', '"$LEGACY_HOME_PAYLOAD"'):
        assert f'rm -rf -- {operand}' in rust
    result = subprocess.run(['/bin/bash', '-n', str(SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
