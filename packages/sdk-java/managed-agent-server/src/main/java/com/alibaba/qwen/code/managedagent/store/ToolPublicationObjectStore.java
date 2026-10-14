package com.alibaba.qwen.code.managedagent.store;

import java.io.InputStream;

/** Private, immutable object storage for one publication service. */
public interface ToolPublicationObjectStore {
    /**
     * One physical create, with no automatic retries, for a key exclusively owned by its durable
     * PUT attempt. An existing key must never be overwritten. Once the complete object is readable,
     * this invocation must not create it again, including after a later deletion.
     */
    void putIfAbsent(String key, byte[] bytes);

    /** The caller closes the stream after verifying its complete contents. */
    InputStream open(String key);

    default InputStream open(String key, Runnable guard) {
        guard.run();
        return open(key);
    }

    default void deleteIfPresent(String key) {
        throw new UnsupportedOperationException("Output deletion is not supported by this adapter");
    }

    /** A versioned or suspended bucket cannot enforce the no-overwrite rule. */
    void requireUnversioned();
}
