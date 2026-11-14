package com.alibaba.qwen.code.managedagent.adapters.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.apache.commons.codec.binary.Hex;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;
import java.util.concurrent.Semaphore;

@Component
public class ManagedExtensionArchiveStore implements ExtensionArchives {
    private final ExtensionArchiveStorage storage;
    private final Semaphore staging = new Semaphore(4);

    @Autowired
    public ManagedExtensionArchiveStore(ExtensionArchiveStorage storage) {
        this.storage = storage;
        if (configured()) {
            storage.validateConfiguration();
        }
    }

    public ManagedExtensionArchiveStore(ManagedAgentSettings properties) {
        this(new DirectoryExtensionArchiveStorage(properties));
    }

    public boolean configured() {
        return !(storage instanceof DirectoryExtensionArchiveStorage directory) || directory.configured();
    }

    public long put(String tenant, String workspace, String digest, InputStream source) throws IOException {
        requireConfigured(digest);
        try (Archive staged = stage(source, digest, -1)) {
            long length = Files.size(staged.path());
            try (InputStream input = Files.newInputStream(staged.path(), LinkOption.NOFOLLOW_LINKS)) {
                storage.putIfAbsent(new ExtensionArchiveStorage.Key(tenant, workspace, digest), length, input);
            }
            return length;
        } catch (IOException error) {
            throw new ManagedAgentException(503, "extension_package_unavailable", "The extension archive write outcome is unknown.", error);
        }
    }

    public Archive verify(String tenant, String workspace, String digest, long length) throws IOException {
        requireConfigured(digest);
        if (length < 1 || length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
            throw unavailable();
        }
        Archive staged = null;
        try (InputStream input = storage.open(new ExtensionArchiveStorage.Key(tenant, workspace, digest))) {
            staged = stage(input, digest, length);
        } catch (IOException | RuntimeException error) {
            if (staged != null) {
                staged.close();
            }
            if (error instanceof IOException) {
                throw new ManagedAgentException(503, "extension_package_unavailable", "The saved extension archive cannot be read.", error);
            }
            throw error;
        }
        return staged;
    }

    private Archive stage(InputStream input, String digest, long expectedLength) throws IOException {
        if (!staging.tryAcquire()) {
            throw new ManagedAgentException(503, "extension_staging_busy", "Extension archive staging is busy.");
        }
        Path temporary = null;
        boolean retained = false;
        try {
            temporary = Files.createTempFile("managed-extension-", ".archive");
            long length = 0;
            var hash = DigestUtils.getSha256Digest();
            Instant deadline = Instant.now().plusSeconds(120);
            try (var output = Files.newOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted() || Instant.now().isAfter(deadline)) {
                        throw new IOException("Extension archive staging deadline exceeded");
                    }
                    length += count;
                    if (length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
                        throw new ManagedAgentException(413, "extension_package_too_large", "Extension archive exceeds 100 MiB.");
                    }
                    hash.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
            }
            if (length == 0 || expectedLength >= 0 && length != expectedLength
                    || !digest.equals(Hex.encodeHexString(hash.digest()))) {
                if (expectedLength >= 0) {
                    throw unavailable();
                }
                throw new ManagedAgentException(400, "extension_package_digest_mismatch", "Extension archive digest does not match its contents.");
            }
            Path leased = temporary;
            Archive result = new Archive(leased, () -> {
                try {
                    Files.deleteIfExists(leased);
                } catch (IOException error) {
                    throw new java.io.UncheckedIOException(error);
                } finally {
                    staging.release();
                }
            });
            retained = true;
            return result;
        } finally {
            if (!retained) {
                try {
                    if (temporary != null) {
                        Files.deleteIfExists(temporary);
                    }
                } finally {
                    staging.release();
                }
            }
        }
    }

    private void requireConfigured(String digest) {
        if (!configured()) {
            throw unavailable();
        }
        if (digest == null || !digest.matches("[a-f0-9]{64}")) {
            throw new ManagedAgentException(400, "invalid_request", "Invalid extension digest.");
        }
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(503, "extension_package_unavailable", "The saved extension archive is unavailable.");
    }
}
