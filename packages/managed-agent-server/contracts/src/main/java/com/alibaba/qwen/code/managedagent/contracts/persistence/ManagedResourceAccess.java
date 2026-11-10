package com.alibaba.qwen.code.managedagent.contracts.persistence;

import java.util.function.Supplier;

/** Retries a SQL-only snapshot after preparing immutable bodies outside its transaction. */
public interface ManagedResourceAccess {
    <T> T readSnapshot(String tenant, String session, Supplier<T> authorizedSql);
}
