package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

/**
 * The external Shell lane's close and recovery on real MySQL 8.4.
 *
 * <p>The three facts the close fence reads — an active execution row, the
 * binding's LOST state and its recovery evidence — are SQL predicates with
 * their own locking and transaction semantics, and the abandonment and
 * generation bump are multi-row writes. H2 cannot establish either, so this leg
 * runs the same cases against an owned MySQL database.
 */
class ExternalShellCloseRecoveryMySqlIT extends ExternalShellCloseRecoveryTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        ManagedSchema.initialize(database.source());
        return database.source();
    }

    @AfterEach
    void dropDatabase() {
        if (database != null) {
            database.close();
            database = null;
        }
    }
}
