# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
"""Linux kernel checks for the documented inherited-stdio capability contract."""
import json
import os
from pathlib import Path
import pty
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest

HELPER = str(Path(sys.argv.pop(1)).resolve())
BWRAP = shlex.split(os.environ.get('QWEN_TEST_BWRAP', 'bwrap')) + [
    '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--',
]


class SandboxStdioTests(unittest.TestCase):
    def run_payload(self, descriptor, program, bridge=False):
        command = ([HELPER, '--relay-stdin'] if bridge else []) + BWRAP
        result = subprocess.run(command + [sys.executable, '-c', program],
                                stdin=descriptor, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_regular_offset_matches_payload_under_confinement(self):
        for consumed in [0, 7]:
            with tempfile.TemporaryFile() as source:
                source.write(b'x' * 1048576)
                source.seek(17)
                report = self.run_payload(source, f'''
import json, os, stat
data = os.read(0, {consumed})
print(json.dumps({{'read': len(data), 'regular': stat.S_ISREG(os.fstat(0).st_mode)}}))
''', bridge=True)
                self.assertEqual(report, {'read': consumed, 'regular': False})
                self.assertEqual(source.tell(), 17 + consumed)

    def test_idle_fifo_writer_does_not_hold_confined_payload_open(self):
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / 'input'
            os.mkfifo(fifo)
            writer = os.open(fifo, os.O_RDWR)
            reader = os.open(fifo, os.O_RDONLY)
            try:
                self.assertEqual(self.run_payload(reader, 'print("0")', bridge=True), 0)
                self.assertTrue(os.get_blocking(reader))
            finally:
                os.close(reader)
                os.close(writer)

    def test_connected_ip_stdio_is_retained_but_new_ip_connection_is_denied(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            with socket.create_connection(listener.getsockname()) as caller:
                peer, _ = listener.accept()
                with peer:
                    peer.sendall(b'capability')
                    report = self.run_payload(caller, f'''
import json, os, socket, stat
data = os.read(0, 10)
os.write(0, b'reply')
with socket.socket() as fresh:
    fresh.settimeout(1)
    try:
        fresh.connect(('127.0.0.1', {listener.getsockname()[1]}))
        blocked = False
    except OSError:
        blocked = True
print(json.dumps({{'data': data.decode(), 'socket': stat.S_ISSOCK(os.fstat(0).st_mode), 'new_connection_blocked': blocked}}))
''')
                    self.assertEqual(report, {'data': 'capability', 'socket': True, 'new_connection_blocked': True})
                    peer.settimeout(1)
                    self.assertEqual(peer.recv(5), b'reply')

    def test_tty_and_character_device_remain_caller_capabilities(self):
        program = 'import json, os, stat; print(json.dumps({"tty": os.isatty(0), "character": stat.S_ISCHR(os.fstat(0).st_mode)}))'
        master, slave = pty.openpty()
        try:
            self.assertEqual(self.run_payload(slave, program), {'tty': True, 'character': True})
        finally:
            os.close(slave)
            os.close(master)
        with open('/dev/null', 'rb') as descriptor:
            self.assertEqual(self.run_payload(descriptor, program), {'tty': False, 'character': True})


unittest.main()
