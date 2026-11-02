from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest


SOURCE = (Path(__file__).resolve().parents[1] / '_install-rust.sh').read_text()


def function(name):
    start = SOURCE.index(f'{name}() {{\n')
    return SOURCE[start:SOURCE.index('\n}\n', start) + 3]


class MacOSInstallRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def run_install(self, mode, previous=True):
        root = Path(self.temp.name) / mode
        app = root / 'Applications/QwenCuaDriver.app'
        stage = root / 'staging/QwenCuaDriver.app'
        bin_dir = root / 'bin'
        bin_dir.mkdir(parents=True)
        for command in ('rm', 'mv', 'ln', 'cp', 'sed'):
            system = '/usr/bin' if command == 'sed' else '/bin'
            (bin_dir / command).symlink_to(f'{system}/{command}')
        stage_binary = stage / 'Contents/MacOS/qwen-cua-driver'
        stage_binary.parent.mkdir(parents=True)
        stage_binary.write_bytes(b'new release')
        stage_binary.chmod(0o755)
        app.parent.mkdir()
        old_binary = app / 'Contents/MacOS/qwen-cua-driver'
        link = bin_dir / 'qwen-cua-driver'
        if previous:
            old_binary.parent.mkdir(parents=True)
            old_binary.write_bytes(b'previous release')
            old_binary.chmod(0o755)
            link.symlink_to(old_binary)
        start = SOURCE.index('LOCK_HELD=0\n')
        lifecycle = SOURCE[start:SOURCE.index('acquire_install_lock() {', start)]
        start = SOURCE.index('if [[ "$OS" == "Darwin" && -n "$SRC_APP" && -d "$SRC_APP" ]]; then')
        branch = SOURCE[start:SOURCE.index('\nelse\n    # Linux: versioned-dirs', start)] + '\nfi\n'
        self.assertEqual(branch.count('! -w "/Applications"'), 1)
        branch = branch.replace('! -w "/Applications"', '! -w "$TEST_ROOT/Applications"')
        helpers = '\n'.join(function(name) for name in (
            'macos_designated_requirement', 'verify_macos_release_app',
        ))
        script = '\n'.join([
            'set -euo pipefail',
            f'TEST_ROOT={shlex.quote(str(root))}',
            f'APP_DEST={shlex.quote(str(app))}',
            f'SRC_APP={shlex.quote(str(stage))}',
            f'TMP_DIR={shlex.quote(str(stage.parent))}',
            f'BIN_LINK={shlex.quote(str(link))}',
            'OS=Darwin', 'BINARY_NAME=qwen-cua-driver',
            'log() { :; }', 'err() { printf "%s\\n" "$*" >&2; }',
            'stop_cua_driver_daemons() { :; }',
            'show_cua_driver_daemon_survivors() { :; }',
            '''fixture_plist() { printf 'com.qwencode.cua-driver\\n'; }
codesign() {
    local app="${@: -1}"
    if [[ "$1" == "-d" ]]; then
        printf 'designated => fixture-requirement\\n'
    elif [[ "$TEST_MODE" == "stage-invalid" && "$app" == "$SRC_APP" ]]; then
        return 1
    elif [[ "$TEST_MODE" == "copy-invalid" && "$app" == "$APP_DEST" ]]; then
        return 1
    fi
}
ditto() {
    if [[ "$TEST_MODE" == "copy-before" ]]; then return 73; fi
    command cp -R "$1" "$2"
    if [[ "$TEST_MODE" == "copy-partial" || "$TEST_MODE" == "restore-fails" ]]; then
        command rm "$2/Contents/MacOS/qwen-cua-driver"
        return 73
    fi
}
mv() {
    if [[ "$TEST_MODE" == "restore-fails" && "$1" == "$APP_DEST".install-backup.* ]]; then
        return 74
    fi
    command mv "$@"
}''',
            helpers, lifecycle, branch,
        ]).replace('/usr/libexec/PlistBuddy', 'fixture_plist')
        result = subprocess.run(
            ['/bin/bash', '-c', script],
            env={'PATH': str(bin_dir), 'TEST_MODE': mode},
            text=True, capture_output=True, timeout=5,
        )
        return result, app, old_binary, link

    def test_copy_failures_restore_the_working_old_bundle(self):
        for mode in ('copy-before', 'copy-partial', 'copy-invalid', 'stage-invalid'):
            with self.subTest(mode=mode):
                result, app, binary, link = self.run_install(mode)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(binary.read_bytes(), b'previous release')
                self.assertEqual(link.read_bytes(), b'previous release')
                self.assertEqual(list(app.parent.glob('*.install-backup.*')), [])

    def test_failed_restore_preserves_a_recoverable_backup(self):
        result, app, _, _ = self.run_install('restore-fails')
        self.assertEqual(result.returncode, 73, result.stderr)
        backups = list(app.parent.glob('*.install-backup.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / 'Contents/MacOS/qwen-cua-driver').read_bytes(), b'previous release')
        self.assertIn(str(backups[0]), result.stderr)

    def test_first_install_failure_removes_the_partial_bundle(self):
        result, app, _, link = self.run_install('copy-partial', previous=False)
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertFalse(app.exists())
        self.assertFalse(link.is_symlink())

    def test_success_installs_the_new_bundle_and_removes_backup(self):
        result, app, binary, link = self.run_install('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(binary.read_bytes(), b'new release')
        self.assertEqual(link.read_bytes(), b'new release')
        self.assertTrue(os.access(link, os.X_OK))
        self.assertEqual(list(app.parent.glob('*.install-backup.*')), [])


if __name__ == '__main__':
    unittest.main()
