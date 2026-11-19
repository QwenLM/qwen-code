# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
"""Real-descriptor tests for the bundled helper's --relay-stdin mode."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

HELPER = str(Path(sys.argv.pop(1)).resolve())


class StdinRelayTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory()
        self.root = Path(self.fixture.name)

    def tearDown(self):
        self.fixture.cleanup()

    def regular(self, count, size=1024 * 1024, initial=17):
        target = self.root / 'input'
        target.write_bytes(b'x' * size)
        target.chmod(0o640)
        program = '''
import json, os, stat, sys, time
n = int(sys.argv[1])
time.sleep(.15)
data = b''
while len(data) < n:
    chunk = os.read(0, min(4096, n - len(data)))
    if not chunk: break
    data += chunk
try: os.fchmod(0, 0o600)
except OSError: pass
print(json.dumps({'read': len(data), 'regular': stat.S_ISREG(os.fstat(0).st_mode),
                  'socket': stat.S_ISSOCK(os.fstat(0).st_mode)}))
'''
        with target.open('rb', buffering=0) as source:
            os.lseek(source.fileno(), initial, os.SEEK_SET)
            result = subprocess.run(
                [HELPER, '--relay-stdin', sys.executable, '-c', program, str(count)],
                stdin=source, capture_output=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'read': min(count, size-initial), 'regular': False, 'socket': True})
            self.assertEqual(os.lseek(source.fileno(), 0, os.SEEK_CUR), initial + min(count, size-initial))
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)

    def test_zero_read_preserves_shared_offset(self):
        self.regular(0)

    def test_partial_read_advances_only_consumed_bytes(self):
        for count in (1, 7, 4095, 4096, 4097):
            with self.subTest(count=count):
                self.regular(count)

    def test_full_read_and_eof(self):
        self.regular(2 * 1024 * 1024)

    def test_small_file_buffered_tail(self):
        self.regular(7, size=25)

    def test_fifo_exit_does_not_wait_for_writer(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        writer = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.set_blocking(reader, True)
            flags = fcntl.fcntl(reader, fcntl.F_GETFL)
            result = subprocess.run([HELPER, '--relay-stdin', '/bin/sh', '-c', 'sleep .15; exit 42'],
                                    stdin=reader, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 42, result.stderr)
            self.assertEqual(fcntl.fcntl(reader, fcntl.F_GETFL), flags)
        finally:
            os.close(writer)
            os.close(reader)

    def test_fifo_streams_and_preserves_flags(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        writer = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.set_blocking(reader, True)
            flags = fcntl.fcntl(reader, fcntl.F_GETFL)
            os.write(writer, b'fifo bytes')
            program = '''
import json, os, stat
info = os.fstat(0)
data = b''
while True:
    chunk = os.read(0, 4096)
    if not chunk: break
    data += chunk
print(json.dumps({'content': data.decode(), 'socket': stat.S_ISSOCK(info.st_mode),
                  'fifo': stat.S_ISFIFO(info.st_mode)}))
'''
            process = subprocess.Popen([HELPER, '--relay-stdin', sys.executable, '-c', program], stdin=reader,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(writer)
            writer = -1
            stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout), {'content': 'fifo bytes', 'socket': True, 'fifo': False})
            self.assertEqual(fcntl.fcntl(reader, fcntl.F_GETFL), flags)
        finally:
            if writer >= 0: os.close(writer)
            os.close(reader)

    def test_signal_exit_and_offset(self):
        source = self.root / 'input'
        source.write_bytes(b'abcdefg' * 10000)
        with source.open('rb', buffering=0) as descriptor:
            process = subprocess.Popen([HELPER, '--relay-stdin', '/bin/sh', '-c', 'kill -TERM $$'],
                                       stdin=descriptor)
            self.assertEqual(process.wait(timeout=3), -signal.SIGTERM)
            self.assertEqual(os.lseek(descriptor.fileno(), 0, os.SEEK_CUR), 0)

    def test_exec_failure_does_not_consume_input(self):
        source = self.root / 'input'
        source.write_bytes(b'unchanged')
        with source.open('rb', buffering=0) as descriptor:
            result = subprocess.run([HELPER, '--relay-stdin', '/does-not-exist'], stdin=descriptor,
                                    capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 125)
            self.assertIn(b'qwen-landlock-run: exec failed:', result.stderr)
            self.assertEqual(os.lseek(descriptor.fileno(), 0, os.SEEK_CUR), 0)

    @unittest.skipUnless(sys.platform == 'linux', 'proc/dev reopening is a Linux contract')
    def test_write_reopening_does_not_change_exit_or_shared_offset(self):
        source = self.root / 'input'
        source.write_bytes(b'x' * 1024 * 1024)
        program = '''
import errno, os, sys
assert os.read(0, 5) == b'xxxxx'
for path in ('/dev/stdin', '/proc/self/fd/0'):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
    except OSError as error:
        assert error.errno == errno.ENXIO, error
    else:
        os.close(fd)
        raise AssertionError('stdin reopened for writing')
try:
    os.write(0, b'command-owned bytes')
except OSError as error:
    assert error.errno == errno.EPIPE, error
else:
    raise AssertionError('stdin accepted a write')
sys.exit(7)
'''
        with source.open('rb', buffering=0) as descriptor:
            descriptor.seek(17)
            result = subprocess.run([HELPER, '--relay-stdin', sys.executable, '-c', program],
                                    stdin=descriptor, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertEqual(descriptor.tell(), 22)

    @unittest.skipUnless(sys.platform == 'linux', 'fault injection uses the Linux helper')
    def test_read_failure_after_prepared_invalidates_the_receipt(self):
        header = Path(__file__).resolve().parents[2] / 'packages/core/vendor/landlock-run/src/stdio-relay.h'
        source = self.root / 'fault.c'
        source.write_text('''
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>
static ssize_t failed_read(int fd, void *buffer, size_t size, off_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  while (access(getenv("QWEN_TEST_READY"), F_OK) != 0) usleep(1000);
  errno = EIO;
  return -1;
}
#define pread failed_read
''' + '#include ' + json.dumps(str(header)) + '''
int main(int argc, char **argv) {
  return argc >= 3 ? relay_stdin(&argv[2]) : 125;
}
''')
        helper = self.root / 'fault-helper'
        compiled = subprocess.run(['cc', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(helper)],
                                  capture_output=True, timeout=10)
        self.assertEqual(compiled.returncode, 0, compiled.stderr)
        ready = self.root / 'ready'
        receipt = self.root / 'receipt'
        payload = '''
import os, sys, time
os.write(3, b'{"state":"prepared","abi":3}\\n')
open(sys.argv[1], 'w').close()
time.sleep(10)
'''
        with tempfile.TemporaryFile() as descriptor:
            descriptor.write(b'original')
            descriptor.seek(0)
            result = subprocess.run(
                ['/bin/sh', '-c', 'exec "$1" --relay-stdin "$2" -c "$3" "$4" 3>"$5"',
                 'sh', str(helper), sys.executable, payload, str(ready), str(receipt)],
                stdin=descriptor, capture_output=True, timeout=3,
                env={**os.environ, 'QWEN_TEST_READY': str(ready)},
            )
            self.assertEqual(result.returncode, 125)
            self.assertIn(b'stdin relay failed', result.stderr)
            self.assertEqual(os.lseek(descriptor.fileno(), 0, os.SEEK_CUR), 0)
        self.assertEqual([json.loads(line)['state'] for line in receipt.read_text().splitlines()],
                         ['prepared', 'stdio-failed'])


unittest.main()
