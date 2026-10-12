package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class CsiApplicationProgressTest {
    private static final String ALIAS = "ec77f5fe1b4225e8f8203d59b5858eb235f9155261c440efaa02efd5513bd2df";
    private static final String PHYSICAL = "a".repeat(64);
    private static final String BINDING = "original-binding";
    private static final String RESERVATION = "cfd417c7-f9dc-450d-b880-5667c7a5b029";

    @Test
    void readyOriginalNeedsMatchingRegistrationAndHolderButNoRetirement() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(false)));
            connection.setAutoCommit(false);
            var progress = JdbcCsiApplicationProgress.lock(connection, original(false));
            assertNull(progress.sealedBindingVersion());
            progress.requireCurrentTime(connection);
            sql(connection, "UPDATE managed_workspace_execution_lease SET binding_id = 'foreign'");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(false)));
            connection.rollback();
        }
    }

    @Test
    void aLaterHolderUsesItsSavedReservationRevisionAndKeepsRuntimeGenerationOne() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            sql(connection, "UPDATE managed_workspace_execution_lease SET csi_revision = 4");
            var ready = JdbcCsiApplicationProgress.lock(connection, original(false));
            assertNull(ready.sealedBindingVersion());
            retire(connection, Instant.now(), 4);
            assertEquals(7L, JdbcCsiApplicationProgress.lock(connection, original(true)).sealedBindingVersion());
            sql(connection, "UPDATE managed_workspace_execution_lease SET csi_revision = 8");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
            connection.rollback();
        }
    }

    @Test
    void settlingUsesImmutableCeilingAndTheOriginalConnection() throws Exception {
        var source = source();
        try (var connection = source.getConnection(); var other = source.getConnection()) {
            connection.setAutoCommit(false);
            long deadline = retire(connection, Instant.now());
            var progress = JdbcCsiApplicationProgress.lock(connection, original(true));
            assertEquals(7L, progress.sealedBindingVersion());
            progress.requireLease(connection, deadline - 1000, deadline);
            other.setAutoCommit(false);
            assertThrows(RuntimeBrokerException.class, () -> progress.requireCurrentTime(other));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, deadline + 1, deadline));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, deadline - 1000, deadline + 1));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, 1, deadline));
            connection.rollback();
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
        }
    }

    @Test
    void expiredDeadlineAndMissingPartialOrFrozenProgressRefuseWithoutRepair() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            retire(connection, Instant.now().minusSeconds(301));
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
            connection.rollback();
            retire(connection, Instant.now());
            for (String change : new String[] {"progress_format = NULL", "progress_version = NULL", "progress_version = 2",
                    "progress_stage = 'FROZEN'", "progress_stage = 'CUT'", "progress_stage = 'DRAINED'",
                    "settlement_deadline_ms = settlement_deadline_ms + 1", "frozen_request_bytes = X'01'",
                    "cut_sha256 = 'unexpected'", "finalize_receipt_bytes = X'01'"}) {
                var savepoint = connection.setSavepoint();
                sql(connection, "UPDATE managed_workspace_csi_retirement SET " + change);
                assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)), change);
                connection.rollback(savepoint);
            }
            assertEquals(7L, JdbcCsiApplicationProgress.lock(connection, original(true)).sealedBindingVersion());
            connection.rollback();
        }
    }

    @Test
    void registrationAndImmutableRetirementIdentityCannotBeSubstituted() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            retire(connection, Instant.now());
            for (String change : new String[] {
                    "UPDATE managed_workspace_csi_registration SET storage_id = 'foreign'",
                    "UPDATE managed_workspace_execution_lease SET csi_registration_revision = 2",
                    "UPDATE managed_workspace_execution_lease SET csi_reservation_id = 'foreign'",
                    "UPDATE managed_workspace_csi_retirement SET retirement_id = 'foreign'",
                    "UPDATE managed_workspace_csi_retirement SET phase = 'RELEASED'"}) {
                var savepoint = connection.setSavepoint();
                sql(connection, change);
                assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)), change);
                connection.rollback(savepoint);
            }
            connection.rollback();
        }
    }

    private static JdbcCsiFilesRetirementGuard.Original original(boolean draining) {
        var context = new ContextBinding("tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);
        var request = CsiFilesRetirementProfile.request(context, "/workspace", "2815c6b8-468c-449a-869a-8794b0d52fca");
        return new JdbcCsiFilesRetirementGuard.Original(request, BINDING, 1,
                draining ? RuntimeBindingRecord.State.DRAINING : RuntimeBindingRecord.State.READY, draining, 9, 2L);
    }

    private static long retire(Connection connection, Instant started) throws Exception {
        return retire(connection, started, 1);
    }

    private static long retire(Connection connection, Instant started, long revision) throws Exception {
        var reservation = Map.of("phase", "RESERVED", "revision", revision, "reservationId", RESERVATION,
                "registrationKey", ALIAS, "registrationRevision", 1, "bindingId", BINDING,
                "runtimeGeneration", 1, "provisionRequestId", "provision");
        var identity = new LinkedHashMap<String, Object>();
        identity.put("operationId", "e6db6013-6be7-4c7d-91d2-890f4ec09d25");
        identity.put("physicalKey", PHYSICAL);
        identity.put("phase", "DRAINING");
        identity.put("reservation", reservation);
        identity.put("sealedBindingVersion", 7);
        identity.put("resourceHandleKind", "kubernetes-workspace");
        identity.put("resourceHandleVersion", 3);
        identity.put("resourceHandleJson", "{\"pod\":\"original\"}");
        identity.put("runtimeInstanceId", "runtime");
        identity.put("leaseId", "lease");
        identity.put("epoch", 1);
        identity.put("leaseDigest", "b".repeat(64));
        identity.put("attestationGeneration", 1);
        identity.put("startedAt", started.toString());
        long deadline = Math.addExact(started.toEpochMilli(), 300_000);
        sql(connection, "UPDATE managed_workspace_execution_lease SET csi_phase = 'DRAINING', csi_revision = "
                + CsiOwnershipRevision.next(revision));
        try (var statement = connection.prepareStatement("INSERT INTO managed_workspace_csi_retirement"
                + " (retirement_id, binding_id, runtime_generation, physical_key, phase, identity_json,"
                + " progress_format, progress_version, progress_stage, settlement_deadline_ms)"
                + " VALUES (?, ?, 1, ?, 'DRAINING', ?, 'qwen-csi-application-retirement/1', 1, 'SETTLING', ?)")) {
            statement.setString(1, (String) identity.get("operationId"));
            statement.setString(2, BINDING);
            statement.setString(3, PHYSICAL);
            statement.setString(4, new ObjectMapper().writeValueAsString(identity));
            statement.setLong(5, deadline);
            statement.executeUpdate();
        }
        return deadline;
    }

    private static JdbcDataSource source() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:application-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        try (var connection = source.getConnection()) {
            sql(connection, "CREATE TABLE managed_workspace_csi_registration (alias_key VARCHAR(64) PRIMARY KEY,"
                    + " tenant_id VARCHAR(64), storage_id VARCHAR(64), physical_key VARCHAR(64), registration_revision BIGINT)");
            sql(connection, "INSERT INTO managed_workspace_csi_registration VALUES ('" + ALIAS + "', 'tenant', 'storage', '" + PHYSICAL + "', 1)");
            sql(connection, "CREATE TABLE managed_workspace_execution_lease (storage_key VARCHAR(64) PRIMARY KEY,"
                    + " storage_kind VARCHAR(8), csi_phase VARCHAR(16), csi_revision BIGINT, csi_reservation_id VARCHAR(64),"
                    + " csi_registration_key VARCHAR(64), csi_registration_revision BIGINT, binding_id VARCHAR(64),"
                    + " runtime_generation BIGINT, csi_provision_request_id VARCHAR(64))");
            sql(connection, "INSERT INTO managed_workspace_execution_lease VALUES ('" + PHYSICAL + "', 'CSI', 'RESERVED',"
                    + " 1, '" + RESERVATION + "', '" + ALIAS + "', 1, '" + BINDING + "', 1, 'provision')");
            sql(connection, "CREATE TABLE managed_workspace_csi_retirement (retirement_id VARCHAR(64), binding_id VARCHAR(64),"
                    + " runtime_generation BIGINT, physical_key VARCHAR(64), phase VARCHAR(16), identity_json CLOB,"
                    + " progress_format VARCHAR(64), progress_version BIGINT, progress_stage VARCHAR(16), settlement_deadline_ms BIGINT,"
                    + " frozen_request_bytes BLOB, frozen_request_sha256 VARCHAR(64), cut_bytes BLOB, cut_sha256 VARCHAR(64),"
                    + " finalize_receipt_bytes BLOB, finalize_receipt_sha256 VARCHAR(64))");
            sql(connection, "CREATE TABLE qwen_runtime_binding (binding_id VARCHAR(64), provisioner_kind VARCHAR(64),"
                    + " provision_request_id VARCHAR(64), resource_handle_version INT, resource_handle_json CLOB,"
                    + " runtime_instance_id VARCHAR(64), runtime_lease_id VARCHAR(64), runtime_epoch BIGINT, attestation_generation BIGINT)");
            sql(connection, "INSERT INTO qwen_runtime_binding VALUES ('" + BINDING + "', 'kubernetes-workspace',"
                    + " 'provision', 3, '{\"pod\":\"original\"}', 'runtime', 'lease', 1, 1)");
        }
        return source;
    }

    private static void sql(Connection connection, String sql) throws Exception {
        try (var statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }
}
