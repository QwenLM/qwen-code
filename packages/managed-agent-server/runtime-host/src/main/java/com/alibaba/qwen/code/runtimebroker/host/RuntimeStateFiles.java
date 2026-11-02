package com.alibaba.qwen.code.runtimebroker.host;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;

public final class RuntimeStateFiles {
    private RuntimeStateFiles() {
    }

    /** UID-resolved owner, so a numeric UID without a passwd entry never gates startup. */
    public static UserPrincipal processOwner() throws IOException {
        Path self = Path.of("/proc/self");
        if (Files.exists(self)) {
            return Files.getOwner(self);
        }
        Path probe = Files.createTempFile("owner-probe-", ".tmp");
        try {
            return Files.getOwner(probe);
        } finally {
            Files.deleteIfExists(probe);
        }
    }

    public static void validateDirectory(Path directory) throws IOException {
        if (!directory.equals(directory.toRealPath())) {
            throw new IOException("Recovery path is not canonical");
        }
        validate(directory, true, processOwner());
    }

    public static void validate(Path path, boolean isDirectory, UserPrincipal owner) throws IOException {
        var attributes = Files.readAttributes(path, java.nio.file.attribute.PosixFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS);
        if (isDirectory ? !attributes.isDirectory() : !attributes.isRegularFile()) {
            throw new IOException("Recovery entry has an invalid type");
        }
        if (!attributes.owner().equals(owner) || !attributes.permissions().equals(
                PosixFilePermissions.fromString(isDirectory ? "rwx------" : "rw-------"))) {
            throw new IOException("Recovery entry is not private to its owner");
        }
    }

}
