package com.alibaba.qwen.code.managedagent.adapters.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;

public final class DirectoryExtensionArchiveStorage implements ExtensionArchiveStorage {
    private final ManagedAgentSettings properties;

    public DirectoryExtensionArchiveStorage(ManagedAgentSettings properties) { this.properties = properties; }
    public boolean configured() { return !StringUtils.isBlank(properties.getExtensions().getArtifactDirectory()); }
    public void validateConfiguration() {
        if (!configured()) {
            throw new IllegalStateException("Extension archive directory is required");
        }
    }

    public void putIfAbsent(Key key, long byteLength, InputStream content) throws IOException {
        Path target = path(key);
        Files.createDirectories(target.getParent());
        if (Files.isSymbolicLink(target.getParent())) {
            throw unavailable();
        }
        if (Files.getFileStore(target.getParent()).supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(target.getParent(), PosixFilePermissions.fromString("rwx------"));
        }
        Path temporary = Files.createTempFile(target.getParent(), ".extension-", ".part");
        try {
            try (var output = Files.newOutputStream(temporary)) {
                content.transferTo(output);
            }
            try (FileChannel file = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                file.force(true);
            }
            try {
                Files.createLink(target, temporary);
            } catch (FileAlreadyExistsException existing) {
                try (InputStream input = open(key)) {
                    if (Files.size(target) != byteLength || !key.digest().equals(DigestUtils.sha256Hex(input))) {
                        throw unavailable();
                    }
                }
            }
            try (FileChannel parent = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
                parent.force(true);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public InputStream open(Key key) throws IOException {
        Path target = path(key);
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw unavailable();
        }
        return Files.newInputStream(target, LinkOption.NOFOLLOW_LINKS);
    }

    private Path path(Key key) {
        validateConfiguration();
        if (key.digest() == null || !key.digest().matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Invalid archive digest");
        }
        Path root = Path.of(properties.getExtensions().getArtifactDirectory()).toAbsolutePath().normalize();
        Path scope = root.resolve(ManagedSchemaKeys.key(key.tenantId(), key.workspaceId()));
        if (Files.isSymbolicLink(root) || Files.isSymbolicLink(scope)) {
            throw unavailable();
        }
        return scope.resolve(key.digest() + ".tar.gz");
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(503, "extension_package_unavailable", "The saved extension archive is unavailable.");
    }
}
