package com.alibaba.qwen.code.runtimebroker.managedschema;

import javax.sql.DataSource;

/** Managed Server and standalone Broker consume one versioned fresh-database schema. */
public final class JdbcRuntimeBrokerSchema {
    private JdbcRuntimeBrokerSchema() {
    }

    public static void initialize(DataSource source) {
        ManagedSchema.initialize(source);
    }
}
