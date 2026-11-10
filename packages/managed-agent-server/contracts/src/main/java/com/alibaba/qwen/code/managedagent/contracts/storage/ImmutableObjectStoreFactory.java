package com.alibaba.qwen.code.managedagent.contracts.storage;

import java.util.Map;

/** Trusted classpath plugin. Construction and discovery must not allocate backend resources. */
public interface ImmutableObjectStoreFactory {
    String kind();

    /** Configuration-only validation; must not contact the backend. */
    void validate(Map<String, String> options);

    /** Transfers close ownership to the caller; failed construction must release its resources. */
    ImmutableObjectStore create(Map<String, String> options);
}
