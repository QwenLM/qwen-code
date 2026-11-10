package example;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStoreFactory;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;

/** Example for local filesystems with atomic hard links and directory fsync. */
public final class LocalObjectStoreFactory implements ImmutableObjectStoreFactory {
    @Override
    public String kind() {
        return "example-local";
    }

    @Override
    public void validate(Map<String, String> options) {
        if (!options.keySet().equals(Set.of("directory")) || !Path.of(options.get("directory")).isAbsolute()) {
            throw new IllegalArgumentException("An absolute directory is required");
        }
    }

    @Override
    public ImmutableObjectStore create(Map<String, String> options) {
        validate(options);
        try {
            Path root = Path.of(options.get("directory"));
            Files.createDirectories(root);
            return new LocalStore(root.toRealPath());
        } catch (IOException failure) {
            throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, failure);
        }
    }

    private static final class LocalStore implements ImmutableObjectStore {
        private final Path root;
        private volatile boolean closed;

        private LocalStore(Path root) {
            this.root = root;
        }

        @Override
        public String identity() {
            return "example-local:" + root;
        }

        @Override
        public void validateConfiguration() {
            requireOpen();
            if (!Files.isDirectory(root) || !Files.isWritable(root)) {
                throw new IllegalArgumentException("Object directory must be writable");
            }
        }

        @Override
        public void putIfAbsent(String key, InputStream source, long length, Runnable guard) {
            requireOpen();
            if (length < 0) {
                throw new IllegalArgumentException("Negative length");
            }
            Path temporary = null;
            boolean published = false;
            try {
                guard.run();
                temporary = Files.createTempFile(root, ".upload-", ".tmp");
                try (var output = Files.newOutputStream(temporary)) {
                    byte[] buffer = new byte[65536];
                    long written = 0;
                    for (;;) {
                        guard.run();
                        requireOpen();
                        int count = source.read(buffer, 0, (int) Math.min(buffer.length, length - written + 1));
                        if (count == -1) {
                            break;
                        }
                        written += count;
                        if (written > length) {
                            throw new IOException("Object exceeds declared length");
                        }
                        output.write(buffer, 0, count);
                    }
                    if (written != length) {
                        throw new IOException("Object is shorter than declared length");
                    }
                }
                try (var file = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                    file.force(true);
                }
                guard.run();
                requireOpen();
                Files.createLink(path(key), temporary);
                published = true;
                syncDirectory();
            } catch (FileAlreadyExistsException failure) {
                throw new ObjectStorageException(ObjectStorageException.Reason.ALREADY_EXISTS, failure);
            } catch (IOException failure) {
                throw new ObjectStorageException(published ? ObjectStorageException.Reason.WRITE_OUTCOME_UNKNOWN
                        : ObjectStorageException.Reason.UNAVAILABLE, failure);
            } finally {
                if (temporary != null) {
                    try {
                        Files.deleteIfExists(temporary);
                    } catch (IOException ignored) {
                        // The unaddressable staging file is never a readable object.
                    }
                }
            }
        }

        @Override
        public InputStream open(String key, Runnable guard) {
            guard.run();
            requireOpen();
            try {
                syncDirectory();
                return new java.io.FilterInputStream(Files.newInputStream(path(key))) {
                    @Override
                    public int read() throws IOException {
                        guard.run();
                        requireOpen();
                        return in.read();
                    }

                    @Override
                    public int read(byte[] bytes, int offset, int length) throws IOException {
                        guard.run();
                        requireOpen();
                        return in.read(bytes, offset, Math.min(length, 65536));
                    }
                };
            } catch (NoSuchFileException failure) {
                throw new ObjectStorageException(ObjectStorageException.Reason.NOT_FOUND, failure);
            } catch (IOException failure) {
                throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, failure);
            }
        }

        @Override
        public void deleteIfPresent(String key, Runnable guard) {
            guard.run();
            requireOpen();
            try {
                Files.deleteIfExists(path(key));
                syncDirectory();
            } catch (IOException failure) {
                throw new ObjectStorageException(ObjectStorageException.Reason.UNAVAILABLE, failure);
            }
        }

        @Override
        public void close() {
            closed = true;
        }

        private void requireOpen() {
            if (closed) {
                throw new IllegalStateException("Object store is closed");
            }
        }

        private Path path(String key) {
            try {
                return root.resolve(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                        .digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
            } catch (NoSuchAlgorithmException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        private void syncDirectory() throws IOException {
            try (var directory = FileChannel.open(root, StandardOpenOption.READ)) {
                directory.force(true);
            }
        }
    }
}
