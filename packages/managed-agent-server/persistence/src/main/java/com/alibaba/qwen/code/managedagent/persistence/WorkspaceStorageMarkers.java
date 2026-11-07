package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

final class WorkspaceStorageMarkers {
    static final String FILE_NAME = ".qwen-managed-storage.json";

    private final ObjectMapper json;

    WorkspaceStorageMarkers(ObjectMapper json) {
        this.json = json;
    }

    Marker read(Path root) {
        Path file = root.resolve(FILE_NAME);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() > 4096) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            ByteBuffer bytes = ByteBuffer.allocate((int) channel.size());
            while (bytes.hasRemaining()) {
                if (channel.read(bytes) <= 0) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
            }
            return json.readValue(bytes.array(), Marker.class);
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    void publish(Path root, Marker expected) {
        Path file = root.resolve(FILE_NAME);
        Path temporary = root.resolve(FILE_NAME + "." + UUID.randomUUID() + ".tmp");
        try {
            byte[] bytes = json.writeValueAsBytes(expected);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer content = ByteBuffer.wrap(bytes);
                while (content.hasRemaining()) {
                    channel.write(content);
                }
                channel.force(true);
            }
            try {
                Files.createLink(file, temporary);
            } catch (java.nio.file.FileAlreadyExistsException ignored) {
                if (!expected.equals(read(root))) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
            }
            try (FileChannel directory = FileChannel.open(root, StandardOpenOption.READ)) {
                directory.force(true);
            }
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        } finally {
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException ignored) {
                // A leftover temporary file cannot authorize a mount.
            }
        }
        if (!expected.equals(read(root))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    Marker readProbe(Path root) {
        Path file = root.resolve(FILE_NAME);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        try (FileChannel channel = FileChannel.open(file,
                StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (channel.size() > 4096) {
                throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
            }
            ByteBuffer bytes = ByteBuffer.allocate((int) channel.size());
            while (bytes.hasRemaining()) {
                if (channel.read(bytes) <= 0) {
                    throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
                }
            }
            return json.readValue(bytes.array(), Marker.class);
        } catch (JsonProcessingException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        } catch (IOException error) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailableTransient(error);
        }
    }

    record Marker(int version, String tenantId, String storageId, String root,
            String hostId, String device, String inode, String birthTime, String registrationId) {
    }
}
