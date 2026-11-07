package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
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
    private static final String PHYSICAL = "a".repeat(64);
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
        jdbc.update("UPDATE ma_storage_owner SET tenant_id = ?, storage_id = ? WHERE storage_key = ?",
                "another-tenant", "another-storage", PHYSICAL);
        transaction.executeWithoutResult(status -> {
            WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE);
            WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE);
        });
        jdbc.update("UPDATE ma_storage_owner SET physical_key = ? WHERE storage_key = ?",
                "b".repeat(64), PHYSICAL);
        assertPhysicalBlocked();
    }

    @Test
    void logicalMigrationFenceStopsNewWorkWhilePhysicalFenceAlsoStopsCommits() {
        storage("LOCAL");
        jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE alias_key = ?",
                "migration", alias());
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requirePhysicalOpenForAdmission(jdbc, TENANT, STORAGE));
        assertThatThrownBy(() -> transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE)))
                .isInstanceOf(RuntimeBrokerException.class);
        jdbc.update("UPDATE ma_storage_owner SET mount_state = 'FENCED' WHERE storage_key = ?", PHYSICAL);
        assertPhysicalBlocked();
    }

    @ParameterizedTest
    @ValueSource(strings = {"tenant", "storage", "registration", "kind"})
    void localAdmissionPreservesAliasAndOwnerChecks(String defect) {
        storage("LOCAL");
        switch (defect) {
            case "tenant" -> jdbc.update("UPDATE ma_storage SET tenant_id = ? WHERE alias_key = ?", "foreign", alias());
            case "storage" -> jdbc.update("UPDATE ma_storage SET storage_id = ? WHERE alias_key = ?", "foreign", alias());
            case "registration" -> jdbc.update("UPDATE ma_storage SET registration_state = 'RETIRED' WHERE alias_key = ?", alias());
            case "kind" -> jdbc.update("UPDATE ma_storage_owner SET storage_kind = 'CSI' WHERE storage_key = ?", PHYSICAL);
            default -> throw new IllegalArgumentException(defect);
        }
        assertPhysicalBlocked();
    }

    @ParameterizedTest
    @ValueSource(strings = {"tenant", "storage", "registration", "fence"})
    void sshAdmissionKeepsItsStricterOriginalOwnerChecks(String defect) {
        storage("SSH_LOCAL");
        transaction.executeWithoutResult(status ->
                WorkspaceMigrationAdmission.requireOpenForAdmission(jdbc, TENANT, STORAGE));
        switch (defect) {
            case "tenant" -> jdbc.update("UPDATE ma_storage_owner SET tenant_id = ? WHERE storage_key = ?", "foreign", PHYSICAL);
            case "storage" -> jdbc.update("UPDATE ma_storage_owner SET storage_id = ? WHERE storage_key = ?", "foreign", PHYSICAL);
            case "registration" -> jdbc.update("UPDATE ma_storage SET registration_state = 'RETIRING' WHERE alias_key = ?", alias());
            case "fence" -> jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE alias_key = ?", "migration", alias());
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
        jdbc.update("DELETE FROM ma_storage_owner WHERE storage_key = ?", PHYSICAL);
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
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id,"
                        + " physical_key, storage_kind, registration_state, registration_revision, registration_json)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, 'REGISTERED', 1, '{}')",
                alias(), JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                JdbcRuntimeBindingRepository.storageFenceKey(STORAGE), TENANT, STORAGE, PHYSICAL, kind);
        jdbc.update("INSERT INTO ma_storage_owner (storage_key, physical_key, tenant_id, storage_id,"
                        + " storage_kind, mount_state) VALUES (?, ?, ?, ?, ?, 'READY')",
                PHYSICAL, PHYSICAL, TENANT, STORAGE, kind);
    }

    private static String alias() {
        return JdbcRuntimeBindingRepository.storageAliasKey(TENANT, STORAGE);
    }
}
