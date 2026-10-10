package com.alibaba.qwen.code.managedagent.store;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** Controlled durable storage for process faults; this is not OSS evidence. */
class O4FileObjects implements ToolPublicationObjectStore {
    protected final Path root;
    O4FileObjects(Path root) { this.root = root.toAbsolutePath().normalize(); }
    protected Path path(String key) {
        Path result = root.resolve(key).normalize();
        if (!result.startsWith(root) || result.equals(root)) { throw new IllegalArgumentException("Invalid test object key"); }
        return result;
    }
    @Override public void putIfAbsent(String key, byte[] bytes) {
        try {
            Path file = path(key);
            Files.createDirectories(file.getParent());
            Files.write(file, bytes, StandardOpenOption.CREATE_NEW);
        } catch (FileAlreadyExistsException expected) {
            // Same immutable-key semantics as the production adapter.
        } catch (IOException error) { throw new IllegalStateException("Test PUT failed", error); }
    }
    @Override public InputStream open(String key) {
        try { return Files.newInputStream(path(key)); }
        catch (IOException error) { throw new IllegalStateException("Test GET failed", error); }
    }
    @Override public void deleteIfPresent(String key) {
        try { Files.deleteIfExists(path(key)); }
        catch (IOException error) { throw new IllegalStateException("Test DELETE failed", error); }
    }
    @Override public void requireUnversioned() {}
}
