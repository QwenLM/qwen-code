package com.alibaba.qwen.code.managedagent.contracts.artifact;

import java.io.InputStream;

/**
 * Private, immutable object storage for one publication service.
 * Implementations report backend failures through {@link ToolPublicationStorageException}.
 */
public interface ToolPublicationObjectStore {
    /** Null is reserved for legacy adapters; generic providers must persist their stable identity. */
    public default String identity() {
        return null;
    }

    public default void requireIdentity(String expected) {
        if (!java.util.Objects.equals(identity(), expected)) {
            throw new ToolPublicationStorageException(ToolPublicationStorageException.Reason.FAILURE,
                    new IllegalStateException("The object belongs to another storage namespace"));
        }
    }

    /**
     * One physical create, with no automatic retries, for a key exclusively owned by its durable
     * PUT attempt. An existing key must never be overwritten. Once the complete object is readable,
     * this invocation must not create it again, including after a later deletion.
     */
    public void putIfAbsent(String key, byte[] bytes);

    public default void putIfAbsent(String key, byte[] bytes, Runnable guard) {
        guard.run();
        putIfAbsent(key, bytes);
    }

    /** The caller closes the stream after verifying its complete contents. */
    public InputStream open(String key);

    /** Check authorization before each new storage request, including implementation retries. */
    public default InputStream open(String key, Runnable guard) {
        guard.run();
        return open(key);
    }

    /** Physically delete the exact owned key; an absent object is already deleted. */
    public default void deleteIfPresent(String key) {
        throw new UnsupportedOperationException("Output deletion is not supported by this adapter");
    }

    public default void deleteIfPresent(String key, Runnable guard) {
        guard.run();
        deleteIfPresent(key);
    }

    /** Validate private, durable, immutable storage and exact-key deletion guarantees. */
    public void validateConfiguration();
}
