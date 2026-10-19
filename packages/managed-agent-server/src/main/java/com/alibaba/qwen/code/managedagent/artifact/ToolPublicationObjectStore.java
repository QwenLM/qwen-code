package com.alibaba.qwen.code.managedagent.artifact;

import java.io.InputStream;

/**
 * Private, immutable object storage for one publication service.
 * Implementations report backend failures through {@link ToolPublicationStorageException}.
 */
public interface ToolPublicationObjectStore {
    /**
     * One physical create, with no automatic retries, for a key exclusively owned by its durable
     * PUT attempt. An existing key must never be overwritten. Once the complete object is readable,
     * this invocation must not create it again, including after a later deletion.
     */
    void putIfAbsent(String key, byte[] bytes);

    /** The caller closes the stream after verifying its complete contents. */
    InputStream open(String key);

    /** Check authorization before each new storage request, including implementation retries. */
    default InputStream open(String key, Runnable guard) {
        guard.run();
        return open(key);
    }

    /** Physically delete the exact owned key; an absent object is already deleted. */
    default void deleteIfPresent(String key) {
        throw new UnsupportedOperationException("Output deletion is not supported by this adapter");
    }

    /** Validate private, durable, immutable storage and exact-key deletion guarantees. */
    void validateConfiguration();
}
