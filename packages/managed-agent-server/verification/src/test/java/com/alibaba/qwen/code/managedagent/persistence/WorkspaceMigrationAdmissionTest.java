package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceMigrationAdmissionTest {
    private static final String TENANT = "tenant";
    private static final String STORAGE = "storage";
    private static final String PHYSICAL = WorkspaceTestStorage.key(TENANT, STORAGE);
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;

    @BeforeEach
    void setUp() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:storage-admission-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
    }

    @Test
    void localAliasesCanShareAnOwnerButCannotNameADifferentPhysicalIdentity() {
        storage("LOCAL");
        jdbc.update("UPDATE ma_storage_owner SET tenant_id = ?, storage_id = ? WHERE physical_id = ?",
                "another-tenant", "another-storage", PHYSICAL);
        transaction.executeWithoutResult(status -> {
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE);
            WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE);
        });
        jdbc.update("UPDATE ma_storage SET physical_id = ? WHERE tenant_id = ? AND storage_id = ?",
                WorkspaceTestStorage.key(TENANT, "other-storage"), TENANT, STORAGE);
        assertPhysicalBlocked();
    }

    @Test
    void logicalMigrationFenceStopsNewWorkWhilePhysicalFenceAlsoStopsCommits() {
        storage("LOCAL");
        jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE tenant_id = ? AND storage_id = ?",
                "migration", TENANT, STORAGE);
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE));
        assertThatThrownBy(() -> transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE)))
                .isInstanceOf(RuntimeBrokerException.class);
        jdbc.update("UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE physical_id = ?", PHYSICAL);
        assertPhysicalBlocked();
    }

    @ParameterizedTest
    @ValueSource(strings = {"tenant", "storage", "registration", "kind"})
    void localAdmissionPreservesAliasAndOwnerChecks(String defect) {
        storage("LOCAL");
        switch (defect) {
            // The alias identity is now the (tenant_id, storage_id) lookup key, so a
            // foreign identity is a different alias: admission scoped to the original
            // identity must not consult it, while the moved alias stays governed under
            // its new identity.
            case "tenant" -> {
                jdbc.update("UPDATE ma_storage SET tenant_id = ? WHERE physical_id = ?", "foreign", PHYSICAL);
                assertAliasMoved("foreign", STORAGE);
                return;
            }
            case "storage" -> {
                jdbc.update("UPDATE ma_storage SET storage_id = ? WHERE physical_id = ?", "foreign", PHYSICAL);
                assertAliasMoved(TENANT, "foreign");
                return;
            }
            case "registration" -> jdbc.update("UPDATE ma_storage SET registration_state = 'RETIRED' WHERE tenant_id = ? AND storage_id = ?", TENANT, STORAGE);
            case "kind" -> jdbc.update("UPDATE ma_storage_owner SET storage_kind = 'CSI' WHERE physical_id = ?", PHYSICAL);
            default -> throw new IllegalArgumentException(defect);
        }
        assertPhysicalBlocked();
    }

    private void assertAliasMoved(String tenant, String storage) {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE tenant_id = ? AND storage_id = ?",
                Integer.class, TENANT, STORAGE)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE tenant_id = ? AND storage_id = ?",
                Integer.class, tenant, storage)).isOne();
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE));
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, tenant, storage));
    }

    @ParameterizedTest
    @ValueSource(strings = {"tenant", "storage", "registration", "fence"})
    void sshAdmissionKeepsItsStricterOriginalOwnerChecks(String defect) {
        storage("SSH_LOCAL");
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE));
        switch (defect) {
            case "tenant" -> jdbc.update("UPDATE ma_storage_owner SET tenant_id = ? WHERE physical_id = ?", "foreign", PHYSICAL);
            case "storage" -> jdbc.update("UPDATE ma_storage_owner SET storage_id = ? WHERE physical_id = ?", "foreign", PHYSICAL);
            case "registration" -> jdbc.update("UPDATE ma_storage SET registration_state = 'RETIRING' WHERE tenant_id = ? AND storage_id = ?", TENANT, STORAGE);
            case "fence" -> jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE tenant_id = ? AND storage_id = ?", "migration", TENANT, STORAGE);
            default -> throw new IllegalArgumentException(defect);
        }
        assertPhysicalBlocked();
    }

    @Test
    void missingAndCsiAliasesDoNotRequireALocalPhysicalOwner() {
        transaction.executeWithoutResult(status -> {
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, null);
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE);
        });
        storage("CSI");
        jdbc.update("DELETE FROM ma_storage_owner WHERE physical_id = ?", PHYSICAL);
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE));
    }

    private void assertPhysicalBlocked() {
        assertThatThrownBy(() -> transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE)))
                .isInstanceOf(RuntimeBrokerException.class)
                .satisfies(error -> assertThat(((RuntimeBrokerException) error).getCode()).isEqualTo("workspace_unavailable"));
        assertThatThrownBy(() -> transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpen(jdbc, TENANT, STORAGE)))
                .isInstanceOf(RuntimeBrokerException.class);
    }

    private void storage(String kind) {
        jdbc.update("INSERT INTO ma_storage (tenant_id, storage_id,"
                        + " physical_id, storage_kind, registration_state, registration_revision, registration_json)"
                        + " VALUES (?, ?, ?, ?, 'REGISTERED', 1, '{}')",
                TENANT, STORAGE, PHYSICAL, kind);
        jdbc.update("INSERT INTO ma_storage_owner (physical_id, tenant_id, storage_id,"
                        + " storage_kind, mount_state) VALUES (?, ?, ?, ?, 'READY')",
                PHYSICAL, TENANT, STORAGE, kind);
    }
}
