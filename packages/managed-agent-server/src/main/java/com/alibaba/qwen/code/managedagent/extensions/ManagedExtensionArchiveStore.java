package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

@Component
public class ManagedExtensionArchiveStore {
    private final ManagedAgentProperties properties;

    public ManagedExtensionArchiveStore(ManagedAgentProperties properties) {
        this.properties = properties;
    }

    public boolean configured() {
        return !StringUtils.isBlank(properties.getExtensions().getArtifactDirectory());
    }

    public long put(String tenant, String workspace, String digest, InputStream source) throws IOException {
        Path target = path(tenant, workspace, digest);
        privateDirectory(target.getParent());
        Path temporary = target.resolveSibling("." + digest + "." + UUID.randomUUID() + ".part");
        long length = 0;
        var hash = DigestUtils.getSha256Digest();
        try {
            try (OutputStream output = Files.newOutputStream(temporary,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = source.read(buffer)) != -1) {
                    length += count;
                    if (length > ManagedExtensionPackages.MAX_ARCHIVE_BYTES) {
                        throw new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE,
                                "extension_package_too_large", "Extension archive exceeds 100 MiB.");
                    }
                    hash.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
            }
            if (length == 0 || !digest.equals(org.apache.commons.codec.binary.Hex.encodeHexString(hash.digest()))) {
                throw new ManagedAgentException(HttpStatus.BAD_REQUEST,
                        "extension_package_digest_mismatch", "Extension archive digest does not match its contents.");
            }
            try (FileChannel file = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                file.force(true);
            }
            try {
                Files.createLink(target, temporary);
            } catch (java.nio.file.FileAlreadyExistsException existing) {
                verify(tenant, workspace, digest, length);
            }
            try (FileChannel directory = FileChannel.open(target.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            }
            return length;
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public Path verify(String tenant, String workspace, String digest, long length) throws IOException {
        Path target = path(tenant, workspace, digest);
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS) || Files.size(target) != length) {
            throw unavailable();
        }
        try (InputStream input = Files.newInputStream(target, LinkOption.NOFOLLOW_LINKS)) {
            if (!digest.equals(DigestUtils.sha256Hex(input))) {
                throw unavailable();
            }
        }
        return target;
    }

    private Path path(String tenant, String workspace, String digest) throws IOException {
        if (!configured()) {
            throw unavailable();
        }
        if (digest == null || !digest.matches("[a-f0-9]{64}")) {
            throw new ManagedAgentException(HttpStatus.BAD_REQUEST, "invalid_request", "Invalid extension digest.");
        }
        Path root = Path.of(properties.getExtensions().getArtifactDirectory()).toAbsolutePath().normalize();
        if (Files.exists(root, LinkOption.NOFOLLOW_LINKS) && Files.isSymbolicLink(root)) {
            throw unavailable();
        }
        Path scope = root.resolve(ManagedSchemaKeys.key(tenant, workspace));
        if (Files.exists(scope, LinkOption.NOFOLLOW_LINKS) && Files.isSymbolicLink(scope)) {
            throw unavailable();
        }
        return scope.resolve(digest + ".tar.gz");
    }

    private static void privateDirectory(Path directory) throws IOException {
        Files.createDirectories(directory);
        if (Files.isSymbolicLink(directory)) {
            throw unavailable();
        }
        if (Files.getFileStore(directory).supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(directory,
                    java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        }
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(HttpStatus.SERVICE_UNAVAILABLE,
                "extension_package_unavailable", "The saved extension archive is unavailable.");
    }
}
