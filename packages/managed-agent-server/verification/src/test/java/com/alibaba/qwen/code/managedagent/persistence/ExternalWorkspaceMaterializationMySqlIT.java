package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.ExternalStorageIdentity;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.StorageAlias;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

class ExternalWorkspaceMaterializationMySqlIT extends ExternalWorkspaceMaterializationTest {
    private IsolatedManagedSchemaMySqlTestDatabase mysql;

    @Override
    DataSource source() {
        mysql = new IsolatedManagedSchemaMySqlTestDatabase();
        return mysql.source();
    }

    @AfterEach
    void closeDatabase() {
        if (mysql != null) {
            mysql.close();
        }
    }

    @Test
    void looksUpTheExactWorkspaceAmongOtherMaterializations() {
        var jdbc = new ManagedSchemaJdbcTemplate(mysql.source());
        var manager = new DataSourceTransactionManager(mysql.source());
        var registrations = new ExternalStorageRegistrationStore(jdbc, manager);
        var store = new ExternalWorkspaceMaterializationStore(jdbc, manager);
        registrations.registerExternalStorage("tenant", "storage:healthy",
                new ExternalStorageRegistration(new ExternalStorageIdentity("provider", "tenant-healthy", 1),
                        new StorageAlias("healthy", "/aliases/healthy", "/worker/healthy")));
        store.materialize("tenant", "workspace", "Workspace", "owner-user", "workspace:workspace");
        store.materialize("tenant", "healthy", "Healthy", "other-owner", "workspace:healthy");

        var workspace = store.findByPhysicalKey("tenant", "provider", "tenant-workspace");
        var healthy = store.findByPhysicalKey("tenant", "provider", "tenant-healthy");

        assertThat(workspace).isPresent().get().satisfies(receipt -> {
            assertThat(receipt.workspaceId()).isEqualTo("workspace");
            assertThat(receipt.storageId()).isEqualTo("workspace");
            assertThat(receipt.ownerActorId()).isEqualTo("owner-user");
            assertThat(jdbc.queryForObject("SELECT materialization_receipt_key FROM ma_workspace"
                    + " WHERE tenant_id = 'tenant' AND workspace_id = 'workspace'", String.class))
                    .isEqualTo(receipt.materializationId());
        });
        assertThat(healthy).isPresent().get().extracting(ExternalWorkspaceMaterializationStore.Receipt::workspaceId)
                .isEqualTo("healthy");
        assertThat(store.findByPhysicalKey("other-tenant", "provider", "tenant-workspace")).isEmpty();
    }
}
