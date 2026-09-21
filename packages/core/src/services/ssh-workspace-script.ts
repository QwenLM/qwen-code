/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Sent as a Python -c argument; requests arrive on stdin, never in shell text.
export const SSH_WORKSPACE_SCRIPT = String.raw`
import base64, errno, fcntl, fnmatch, hashlib, json, os, re, selectors, stat, subprocess, sys, time, uuid

MAX_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 50000
MAX_SEARCH_BYTES = 4 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

class WorkspaceError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

def fail(code, message):
    raise WorkspaceError(code, message)

def integer(value, default, maximum):
    value = default if value is None else value
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > maximum:
        fail('invalid_argument', 'Invalid numeric limit.')
    return value

def normalized(value):
    if not isinstance(value, str) or '\0' in value or len(value) > 4096:
        fail('invalid_argument', 'Invalid remote path.')
    if '..' in value.split('/'):
        fail('path_outside_workspace', 'Parent path traversal is not supported.')
    target = os.path.normpath(value if value.startswith('/') else os.path.join(root, value))
    if os.path.commonpath([root, target]) != root:
        fail('path_outside_workspace', 'Path is outside the SSH workspace.')
    return target

def child_directory(fd, name):
    if stat.S_ISLNK(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
        fail('symlink_escape', 'Traversing a symbolic link is not allowed.')
    return os.open(name, DIR_FLAGS, dir_fd=fd)

def open_directory(absolute):
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in absolute.split('/'):
            if not part:
                continue
            next_fd = child_directory(fd, part)
            os.close(fd)
            fd = next_fd
        return fd
    except:
        os.close(fd)
        raise

def parent(value):
    target = normalized(value)
    relative = os.path.relpath(target, root)
    components = relative.split('/')
    fd = os.dup(root_fd)
    try:
        for component in components[:-1]:
            next_fd = child_directory(fd, component)
            os.close(fd)
            fd = next_fd
        return fd, components[-1], target
    except:
        os.close(fd)
        raise

def kind(info):
    if stat.S_ISLNK(info.st_mode):
        return 'symlink'
    if stat.S_ISDIR(info.st_mode):
        return 'directory'
    if stat.S_ISREG(info.st_mode):
        return 'file'
    return 'other'

def inspect(value):
    fd, name, target = parent(value)
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    finally:
        os.close(fd)

def read_data(value, maximum=MAX_BYTES, truncate=False, offset=None):
    directory, name, target = parent(value)
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail('not_file', 'The remote path is not a regular file.')
        if offset is not None:
            os.lseek(fd, offset, os.SEEK_SET)
        if info.st_size > maximum and not truncate and offset is None:
            fail('file_too_large', 'Remote file exceeds the 16 MiB limit.')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, maximum + (1 if offset is None else 0) - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                if truncate:
                    return b''.join(chunks)[:maximum], info
                fail('file_too_large', 'Remote file exceeds the 16 MiB limit.')
        return b''.join(chunks), info
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)

def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def list_names(fd):
    result = []
    with os.scandir(fd) as entries:
        for entry in entries:
            result.append(entry.name)
            if len(result) > MAX_ENTRIES:
                fail('too_large', 'Remote directory exceeds the entry limit.')
    return sorted(result)

def git_output(args):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'})
    process = subprocess.Popen(['git', '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
    chunks, size, deadline = {'stdout': [], 'stderr': []}, 0, time.monotonic() + 10
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                fail('timeout', 'Remote Git file listing timed out.')
            for key, event in selector.select(0.1):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                size += len(chunk)
                if size > MAX_SEARCH_BYTES:
                    fail('too_large', 'Remote Git file listing exceeds the search limit.')
                chunks[key.data].append(chunk)
        return process.wait(timeout=1), b''.join(chunks['stdout']), b''.join(chunks['stderr'])
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()

def search_files(include_ignored):
    if not include_ignored:
        try:
            code, output, diagnostic = git_output(['rev-parse', '--is-inside-work-tree'])
        except FileNotFoundError:
            code, output, diagnostic = 128, b'', b'not a git repository'
        if code == 0 and output.strip() == b'true':
            code, output, diagnostic = git_output(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
            if code:
                fail('search_failed', 'Cannot enumerate remote Git files.')
            paths = list(dict.fromkeys(part.decode('utf-8') for part in output.split(b'\0') if part))
            ignored, incomplete = set(), bool(diagnostic)
            for exclude in ['--exclude-standard', '--exclude-per-directory=.qwenignore']:
                code, output, diagnostic = git_output(['ls-files', '-z', '--cached', '--ignored', exclude])
                if code:
                    fail('search_failed', 'Cannot enumerate remote ignored files.')
                incomplete = incomplete or bool(diagnostic)
                ignored.update(part.decode('utf-8') for part in output.split(b'\0') if part)
            if len(paths) > MAX_ENTRIES:
                fail('too_large', 'Remote workspace exceeds the search file limit.')
            included = set()
            batch, batch_bytes = [], 0
            for candidate in paths + [None]:
                spec = None if candidate is None else ':(literal)' + candidate
                size = 0 if spec is None else len(spec.encode('utf-8')) + 1
                if batch and (spec is None or batch_bytes + size > 65536):
                    code, output, diagnostic = git_output(['ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.qwenignore', '--'] + batch)
                    if code:
                        fail('search_failed', 'Cannot apply remote Qwen ignore rules.')
                    included.update(part.decode('utf-8') for part in output.split(b'\0') if part)
                    incomplete = incomplete or bool(diagnostic)
                    batch, batch_bytes = [], 0
                if spec is not None:
                    batch.append(spec)
                    batch_bytes += size
            paths = [path for path in paths if path in included]
            return [normalized(path) for path in paths if path not in ignored and '.git' not in path.split('/')], incomplete
        if not (code == 0 and output.strip() == b'false') and b'not a git repository' not in diagnostic:
            fail('search_failed', 'Cannot determine remote Git ignore rules.')
    result, incomplete = [], False
    def walk(fd, directory, depth):
        nonlocal incomplete
        if depth > 64:
            fail('too_large', 'Remote directory nesting exceeds the search limit.')
        names = list_names(fd)
        if len(names) + len(result) > MAX_ENTRIES:
            fail('too_large', 'Remote workspace exceeds the search file limit.')
        if not include_ignored and any(name in names for name in ['.gitignore', '.ignore', '.qwenignore']):
            fail('unsupported_ignore', 'Ignore files outside a Git repository are not supported for SSH search.')
        for name in sorted(names):
            if name == '.git':
                continue
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except (FileNotFoundError, PermissionError):
                incomplete = True
                continue
            if stat.S_ISLNK(info.st_mode):
                continue
            target = os.path.join(directory, name)
            if stat.S_ISREG(info.st_mode):
                result.append(target)
            elif stat.S_ISDIR(info.st_mode):
                try:
                    child = child_directory(fd, name)
                    try:
                        walk(child, target, depth + 1)
                    finally:
                        os.close(child)
                except (FileNotFoundError, PermissionError):
                    incomplete = True
    walk(root_fd, root, 0)
    return result, incomplete

def matches(path, pattern, basename=False, case_sensitive=True):
    if not isinstance(pattern, str) or len(pattern) > 4096 or pattern.startswith('/') or '..' in pattern.split('/'):
        fail('invalid_argument', 'Use a relative glob pattern without parent traversal.')
    if any(token in pattern for token in ['{', '}', '@(', '!(', '+(', '?(', '*(']):
        fail('unsupported_pattern', 'Brace expansion and extended glob patterns are not supported for SSH search.')
    if not case_sensitive:
        path, pattern = path.casefold(), pattern.casefold()
    if basename and '/' not in pattern:
        return fnmatch.fnmatchcase(os.path.basename(path), pattern)
    parts, patterns = path.split('/'), (pattern[2:] if pattern.startswith('./') else pattern).split('/')
    memo = {}
    def match(i, j):
        if (i, j) in memo:
            return memo[i, j]
        if j == len(patterns):
            result = i == len(parts)
        elif patterns[j] == '**':
            result = match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        else:
            result = i < len(parts) and fnmatch.fnmatchcase(parts[i], patterns[j]) and match(i + 1, j + 1)
        memo[i, j] = result
        return result
    return match(0, 0)

def dispatch(operation, params):
    path = params.get('path') or params.get('cwd') or '.'
    if operation == 'probe':
        target = normalized(path)
        fd = open_directory(target)
        os.close(fd)
        return {'directory': target}
    if operation == 'execute':
        target = normalized(path)
        fd = open_directory(target)
        os.fchdir(fd)
        os.close(fd)
        command = params.get('command')
        if not isinstance(command, str) or '\0' in command:
            fail('invalid_argument', 'Invalid remote shell command.')
        process = subprocess.Popen(['/bin/sh', '-c', command], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        try:
            while selector.get_map():
                for key, event in selector.select():
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    print(json.dumps({'stream': key.data, 'data': base64.b64encode(chunk).decode('ascii')}), flush=True)
            code = process.wait()
            return {'exitCode': code if code >= 0 else 128 - code}
        finally:
            selector.close()
            process.stdout.close()
            process.stderr.close()
    if operation == 'stat':
        info = inspect(path)
        return {'kind': kind(info), 'sizeBytes': info.st_size, 'modifiedMs': info.st_mtime * 1000}
    if operation == 'gitUntrackedStats':
        paths = params.get('paths')
        if not isinstance(paths, list) or len(paths) > 500:
            fail('invalid_argument', 'Git untracked statistics support at most 500 paths.')
        maximum = integer(params.get('maxBytes'), 1000000, MAX_BYTES)
        maximum_lines = integer(params.get('maxLines'), 0, 400)
        result = []
        for path in paths:
            try:
                data, info = read_data(path, maximum, True)
                binary = b'\0' in data[:8192]
                lines = data.decode('utf-8', errors='replace').split('\n')
                if lines[-1] == '':
                    lines.pop()
                row = {'path': path, 'added': 0 if binary else len(lines), 'isBinary': binary, 'truncated': info.st_size > len(data)}
                if maximum_lines:
                    row['lines'] = [] if binary else lines[:maximum_lines]
                    row['truncated'] = row['truncated'] or (not binary and len(lines) > maximum_lines)
                result.append(row)
            except WorkspaceError as error:
                if error.code not in ['symlink_escape', 'not_file', 'unsupported_file']:
                    raise
                result.append({'path': path, 'added': 0, 'isBinary': True, 'truncated': False})
            except OSError as error:
                if error.errno not in [errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EACCES, errno.EPERM]:
                    raise
                result.append({'path': path, 'added': 0, 'isBinary': True, 'truncated': False})
        return result
    if operation == 'read':
        data, info = read_data(path)
        if b'\0' in data:
            fail('binary_file', 'Remote file contains binary data; use a byte read.')
        return {'content': data.decode('utf-8'), 'hash': digest(data), 'sizeBytes': len(data)}
    if operation == 'readBytes':
        offset = integer(params.get('offset'), 0, 9007199254740991)
        maximum = integer(params.get('maxBytes'), MAX_BYTES, MAX_BYTES)
        data, info = read_data(path, maximum, offset=offset)
        result = {'sizeBytes': info.st_size, 'data': base64.b64encode(data).decode('ascii')}
        if offset == 0 and len(data) == info.st_size:
            result['hash'] = digest(data)
        return result
    if operation == 'list':
        target = normalized(path)
        fd = open_directory(target)
        try:
            names = list_names(fd)
            maximum = integer(params.get('maxEntries'), MAX_ENTRIES, MAX_ENTRIES)
            ignored = {'.git'}
            try:
                code, output, diagnostic = git_output(['rev-parse', '--is-inside-work-tree'])
                if code == 0 and output.strip() == b'true':
                    for exclude in ['--exclude-standard', '--exclude-per-directory=.qwenignore']:
                        code, output, diagnostic = git_output(['ls-files', '-z', '--cached', '--others', '--ignored', '--directory', exclude, '--', ':(literal)' + os.path.relpath(target, root)])
                        if code:
                            fail('search_failed', 'Cannot determine remote directory ignore rules.')
                        ignored.update(part.decode('utf-8').rstrip('/') for part in output.split(b'\0') if part)
            except FileNotFoundError:
                pass
            entries = []
            for name in names:
                relative = os.path.relpath(os.path.join(target, name), root)
                parts = relative.split('/')
                is_ignored = any('/'.join(parts[:index + 1]) in ignored for index in range(len(parts)))
                if is_ignored and params.get('includeIgnored') is not True:
                    continue
                entries.append({'name': name, 'kind': kind(os.stat(name, dir_fd=fd, follow_symlinks=False)), 'ignored': is_ignored})
            return entries[:maximum]
        finally:
            os.close(fd)
    if operation == 'mkdir':
        target = normalized(path)
        if params.get('recursive'):
            fd = os.dup(root_fd)
            try:
                for part in os.path.relpath(target, root).split('/'):
                    try:
                        os.mkdir(part, 0o755, dir_fd=fd)
                    except FileExistsError:
                        pass
                    child = child_directory(fd, part)
                    os.close(fd)
                    fd = child
            finally:
                os.close(fd)
        else:
            fd, name, target = parent(path)
            try:
                os.mkdir(name, 0o755, dir_fd=fd)
            finally:
                os.close(fd)
        return {'directory': target}
    if operation == 'write':
        if ('content' in params) == ('data' in params):
            fail('invalid_argument', 'Provide exactly one of content or base64 data.')
        if not isinstance(params.get('content', params.get('data')), str):
            fail('invalid_argument', 'File content must be a string.')
        data = params['content'].encode('utf-8') if 'content' in params else base64.b64decode(params['data'], validate=True)
        if len(data) > MAX_BYTES:
            fail('file_too_large', 'Remote write exceeds the 16 MiB limit.')
        mode = params.get('mode', 'overwrite')
        expected = params.get('expectedHash')
        if mode not in ['create', 'overwrite', 'replace'] or (mode == 'replace' and not expected):
            fail('invalid_argument', 'Replace writes require an expected content hash.')
        if mode == 'create' and params.get('createParents') is True:
            dispatch('mkdir', {'path': os.path.dirname(normalized(path)), 'recursive': True})
        fd, name, target = parent(path)
        temporary = '.qwen-write-' + uuid.uuid4().hex
        temporary_exists = False
        try:
            fcntl.flock(root_fd, fcntl.LOCK_EX)
            try:
                existing = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and stat.S_ISLNK(existing.st_mode):
                fail('symlink_escape', 'Writing through a symbolic link is not allowed.')
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                fail('not_file', 'The write target is not a regular file.')
            if mode == 'create' and existing is not None:
                fail('file_already_exists', 'The remote file already exists.')
            if mode == 'replace' and existing is None:
                fail('path_not_found', 'The remote file no longer exists.')
            if expected is not None:
                if existing is None or digest(read_data(path)[0]) != expected:
                    fail('hash_mismatch', 'The remote file changed; read it again before writing.')
            output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            temporary_exists = True
            try:
                with os.fdopen(output, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), stat.S_IMODE(existing.st_mode) if existing else 0o600)
                    os.fsync(stream.fileno())
                if mode == 'create':
                    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    os.unlink(temporary, dir_fd=fd)
                else:
                    os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
                temporary_exists = False
                try:
                    os.fsync(fd)
                except OSError as error:
                    if error.errno not in [errno.EINVAL, errno.ENOSYS, errno.ENOTSUP]:
                        raise
            finally:
                if temporary_exists:
                    os.unlink(temporary, dir_fd=fd)
            return {'created': existing is None, 'sizeBytes': len(data), 'hash': digest(data)}
        finally:
            os.close(fd)
            fcntl.flock(root_fd, fcntl.LOCK_UN)
    if operation in ['glob', 'grep']:
        base = normalized(path)
        base_info = inspect(path)
        if stat.S_ISLNK(base_info.st_mode):
            fail('symlink_escape', 'Searching through a symbolic link is not allowed.')
        if not stat.S_ISDIR(base_info.st_mode) and not stat.S_ISREG(base_info.st_mode):
            fail('not_file', 'Search requires a regular file or directory.')
        pattern = params.get('pattern')
        if not isinstance(pattern, str):
            fail('invalid_argument', 'Search pattern must be a string.')
        if operation == 'glob':
            matches('', pattern)
        include = params.get('glob', params.get('include'))
        if operation == 'grep' and include is not None:
            matches('', include, True)
        maximum = integer(params.get('limit', params.get('maxResults')), 1000, MAX_ENTRIES + 1)
        files, incomplete = ([base], False) if stat.S_ISREG(base_info.st_mode) else search_files(params.get('includeIgnored') is True)
        files = [file for file in files if os.path.commonpath([base, file]) == base]
        result, result_bytes, truncated = [], 0, False
        if operation == 'grep':
            if params.get('context'):
                fail('unsupported_operation', 'SSH grep context lines are not supported.')
            try:
                regex = re.compile(re.escape(pattern) if params.get('fixedStrings') else pattern, 0 if params.get('caseSensitive', True) else re.IGNORECASE)
            except re.error:
                fail('invalid_argument', 'Invalid search regular expression.')
        for file in sorted(files):
            try:
                info = inspect(file)
            except (FileNotFoundError, PermissionError):
                incomplete = True
                continue
            if not stat.S_ISREG(info.st_mode):
                incomplete = incomplete or stat.S_ISDIR(info.st_mode)
                continue
            relative = os.path.relpath(file, base if stat.S_ISDIR(base_info.st_mode) else os.path.dirname(base))
            if operation == 'glob':
                if matches(relative, pattern, case_sensitive=params.get('caseSensitive', True)):
                    result.append((info.st_mtime, file))
            else:
                if include and not matches(relative, include, True):
                    continue
                try:
                    data, info = read_data(file, truncate=True)
                    incomplete = incomplete or info.st_size > len(data)
                except (FileNotFoundError, PermissionError):
                    incomplete = True
                    continue
                if b'\0' in data:
                    continue
                for index, line in enumerate(data.decode('utf-8', errors='replace').splitlines(), 1):
                    if regex.search(line):
                        text = os.path.relpath(file, root) + ':' + str(index) + ':' + line
                        result_bytes += len(text.encode('utf-8'))
                        if len(result) >= maximum or result_bytes > MAX_SEARCH_BYTES:
                            truncated = True
                            break
                        result.append(text)
                if truncated:
                    break
        if operation == 'glob':
            result.sort(key=lambda item: (-item[0], item[1]))
            return {'paths': [item[1] for item in result[:maximum]], 'truncated': incomplete or len(result) > maximum}
        return {'text': '\n'.join(result), 'truncated': incomplete or truncated}
    fail('unsupported_operation', 'Unsupported SSH filesystem operation: ' + str(operation))

root_fd, request = None, {}
try:
    request = json.loads(sys.stdin.buffer.read(32 * 1024 * 1024 + 1))
    root = request['root']
    if not isinstance(root, str) or not root.startswith('/') or '\0' in root or '..' in root.split('/'):
        fail('invalid_argument', 'Invalid SSH workspace root.')
    root = os.path.realpath(root) if request['operation'] == 'probe' else os.path.normpath(root)
    root_fd = open_directory(root)
    result = dispatch(request['operation'], request['params'])
    print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
except Exception as error:
    if isinstance(error, WorkspaceError):
        code, message = error.code, error.message
    elif isinstance(error, OSError):
        code = {errno.ENOENT: 'path_not_found', errno.ELOOP: 'symlink_escape', errno.ENOTDIR: 'not_directory', errno.EEXIST: 'file_already_exists', errno.EACCES: 'permission_denied', errno.EPERM: 'permission_denied'}.get(error.errno, 'io_error')
        message = str(error)
    elif isinstance(error, UnicodeError):
        code, message = 'unsupported_encoding', 'Remote text is not valid UTF-8.'
    elif isinstance(error, (ValueError, TypeError, KeyError)):
        code, message = 'invalid_argument', str(error)
    else:
        code, message = 'io_error', str(error)
    print(json.dumps({'ok': False, 'error': {'code': code, 'message': message}}, ensure_ascii=False))
finally:
    if root_fd is not None:
        os.close(root_fd)
`;
