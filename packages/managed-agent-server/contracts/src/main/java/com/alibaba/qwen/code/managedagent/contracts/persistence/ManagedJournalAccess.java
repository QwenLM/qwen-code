package com.alibaba.qwen.code.managedagent.contracts.persistence;

import java.util.function.Supplier;

/** Authorized callers acquire a HOT pin before beginning a transaction that reads journal bodies. */
public interface ManagedJournalAccess {
    Lease pinHot(String tenant, String session);

    void ensureHot(String tenant, String session);

    default <T> T read(String tenant, String session, Supplier<T> action) {
        try (Lease lease = pinHot(tenant, session)) {
            lease.check();
            T value = action.get();
            lease.check();
            return value;
        }
    }

    interface Lease extends AutoCloseable {
        void check();

        @Override
        void close();
    }
}
