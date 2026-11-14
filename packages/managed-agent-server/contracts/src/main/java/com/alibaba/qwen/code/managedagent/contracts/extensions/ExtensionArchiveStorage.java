package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.io.IOException;
import java.io.InputStream;

/** Private, durable immutable storage shared by every replica using the Managed catalog. */
public interface ExtensionArchiveStorage {
    record Key(String tenantId, String workspaceId, String digest) { }

    /** Atomically create a complete object; an existing identical object is success, never overwrite it. */
    void putIfAbsent(Key key, long byteLength, InputStream content) throws IOException;
    InputStream open(Key key) throws IOException;
    /** Validate configuration only. Storage I/O must have finite timeouts and must not replay unknown writes. */
    void validateConfiguration();
}
