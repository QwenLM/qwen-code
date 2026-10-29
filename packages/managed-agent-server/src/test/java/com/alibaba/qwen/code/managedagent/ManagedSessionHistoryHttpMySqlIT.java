package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

class ManagedSessionHistoryHttpMySqlIT {
    @Test
    void coreRestoresSnapshotAndTailThroughRealHttpAndMySql(@TempDir Path directory) throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSessionHistoryHttpFixture.run(directory, database.url(), System.getProperty("mysql.user"),
                    System.getProperty("mysql.password", ""), "com.mysql.cj.jdbc.Driver", 1100, "mysql");
        }
    }
}
