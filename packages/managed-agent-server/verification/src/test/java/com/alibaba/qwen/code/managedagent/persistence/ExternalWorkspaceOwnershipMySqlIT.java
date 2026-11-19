package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

class ExternalWorkspaceOwnershipMySqlIT extends ExternalWorkspaceOwnershipTest {
    private IsolatedManagedSchemaMySqlTestDatabase mysql;

    @Override
    DataSource source() {
        mysql = new IsolatedManagedSchemaMySqlTestDatabase();
        return mysql.source();
    }

    @Test
    void externalPredicatesBoundTenantPlacementWait() throws Exception {
        verifyPlacementPredicateTimeouts();
    }

    @AfterEach
    void closeDatabase() {
        if (mysql != null) {
            mysql.close();
        }
    }
}
