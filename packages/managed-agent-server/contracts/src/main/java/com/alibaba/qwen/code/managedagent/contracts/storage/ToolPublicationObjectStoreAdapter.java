package com.alibaba.qwen.code.managedagent.contracts.storage;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationStorageException;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Objects;
import java.util.function.Supplier;

/** Keeps existing Tool Publication state machines independent of provider selection. */
public final class ToolPublicationObjectStoreAdapter implements ToolPublicationObjectStore {
    private final ImmutableObjectStore store;
    private final boolean legacyIdentity;

    public ToolPublicationObjectStoreAdapter(ImmutableObjectStore store) {
        this(store, false);
    }

    public ToolPublicationObjectStoreAdapter(ImmutableObjectStore store, boolean legacyIdentity) {
        this.store = Objects.requireNonNull(store);
        this.legacyIdentity = legacyIdentity;
    }

    public ImmutableObjectStore store() {
        return store;
    }

    @Override
    public String identity() {
        return store.identity();
    }

    @Override
    public void requireIdentity(String expected) {
        if (expected == null && legacyIdentity) {
            return;
        }
        ToolPublicationObjectStore.super.requireIdentity(expected);
    }

    @Override
    public void putIfAbsent(String key, byte[] bytes) {
        putIfAbsent(key, bytes, () -> {});
    }

    @Override
    public void putIfAbsent(String key, byte[] bytes, Runnable guard) {
        translate(() -> {
            try {
                store.putIfAbsent(key, new ByteArrayInputStream(bytes), bytes.length, guard);
            } catch (ObjectStorageException error) {
                if (error.reason() != ObjectStorageException.Reason.ALREADY_EXISTS) {
                    throw error;
                }
            }
            return null;
        });
    }

    @Override
    public InputStream open(String key) {
        return open(key, () -> {});
    }

    @Override
    public InputStream open(String key, Runnable guard) {
        return translate(() -> store.open(key, 64L * 1024 * 1024 + 1, guard));
    }

    @Override
    public void deleteIfPresent(String key) {
        deleteIfPresent(key, () -> {});
    }

    @Override
    public void deleteIfPresent(String key, Runnable guard) {
        translate(() -> {
            store.deleteIfPresent(key, guard);
            return null;
        });
    }

    @Override
    public void validateConfiguration() {
        translate(() -> {
            store.validateConfiguration();
            return null;
        });
    }

    private static <T> T translate(Supplier<T> call) {
        try {
            return call.get();
        } catch (ObjectStorageException error) {
            var reason = error.reason() == ObjectStorageException.Reason.ACCESS_DENIED
                    ? ToolPublicationStorageException.Reason.ACCESS_DENIED
                    : ToolPublicationStorageException.Reason.FAILURE;
            throw new ToolPublicationStorageException(reason, error);
        }
    }
}
