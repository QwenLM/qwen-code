package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** Reads the existing immutable authorization ceiling, not physical retirement evidence. */
final class JdbcCsiRetirementSeal {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).build()).build())
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_CREATOR_PROPERTIES);

    private JdbcCsiRetirementSeal() {
    }

    static Long lock(Connection connection, JdbcCsiFilesRetirementGuard.Original original) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT retirement_id, physical_key, phase, identity_json FROM managed_workspace_csi_retirement"
                        + " WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE")) {
            statement.setString(1, original.bindingId());
            statement.setLong(2, original.generation());
            try (var row = statement.executeQuery()) {
                if (!row.next()) {
                    require(original.state() == RuntimeBindingRecord.State.READY && !original.draining());
                    return null;
                }
                String encoded = row.getString("identity_json");
                require(encoded != null && encoded.length() <= 256 * 1024
                        && encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 256 * 1024);
                require(original.state() == RuntimeBindingRecord.State.DRAINING && original.draining());
                Identity identity = identity(encoded, original, row.getString("retirement_id"),
                        row.getString("physical_key"), row.getString("phase"));
                require(!row.next());
                verifyAssociation(connection, original, identity);
                return identity.sealedBindingVersion();
            }
        } catch (IOException | IllegalArgumentException | NullPointerException | java.time.format.DateTimeParseException error) {
            throw unavailable();
        }
    }

    static long readHistorical(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            byte[] frozenBytes, JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        read.requireHistorical(connection);
        require(frozenBytes != null && frozenBytes.length > 0 && frozenBytes.length <= 32 * 1024 * 1024);
        try (var statement = read.statement(connection,
                "SELECT retirement_id, physical_key, phase, identity_json, progress_format, progress_version,"
                        + " progress_stage, settlement_deadline_ms, frozen_request_bytes, frozen_request_sha256"
                        + " FROM managed_workspace_csi_retirement WHERE binding_id = ? AND runtime_generation = ?")) {
            statement.setString(1, original.bindingId());
            statement.setLong(2, original.generation());
            try (var row = statement.executeQuery()) {
                require(row.next() && "qwen-csi-application-retirement/1".equals(row.getString("progress_format"))
                        && row.getLong("progress_version") == 4 && "DRAINED".equals(row.getString("progress_stage")));
                String encoded = row.getString("identity_json");
                require(encoded != null && encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 256 * 1024);
                Identity identity = identity(encoded, original, row.getString("retirement_id"),
                        row.getString("physical_key"), row.getString("phase"));
                require(original.draining() && (original.state() == RuntimeBindingRecord.State.DRAINING
                        || original.state() == RuntimeBindingRecord.State.RELEASED)
                        && row.getLong("settlement_deadline_ms") == Math.addExact(Instant.parse(identity.startedAt()).toEpochMilli(), 300000L));
                byte[] saved;
                try (var input = row.getBinaryStream("frozen_request_bytes")) {
                    require(input != null);
                    saved = input.readNBytes(32 * 1024 * 1024 + 1);
                }
                require(java.util.Arrays.equals(frozenBytes, saved)
                        && CsiNativeActivationProof.sha256(saved).equals(row.getString("frozen_request_sha256")));
                var frozen = JSON.valueToTree(ManagedCsiFilesProtocol.parse(saved, 32 * 1024 * 1024));
                require("qwen-csi-application-frozen/1".equals(frozen.path("format").textValue())
                        && identity.operationId().equals(frozen.path("retirementId").textValue())
                        && original.bindingId().equals(frozen.path("bindingId").textValue())
                        && original.request().requestKey().equals(frozen.path("requestKey").textValue())
                        && CsiNativeActivationProof.number(frozen.get("sealedBindingVersion")) == identity.sealedBindingVersion()
                        && !row.next());
                verifyImmutableAssociation(connection, original, identity, read);
                return identity.sealedBindingVersion();
            }
        } catch (IOException | IllegalArgumentException | NullPointerException | java.time.format.DateTimeParseException
                | ArithmeticException error) {
            throw unavailable();
        }
    }

    private static Identity identity(String encoded, JdbcCsiFilesRetirementGuard.Original original,
            String retirement, String physical, String phase) throws IOException {
        Identity identity = JSON.readValue(encoded, Identity.class);
        require(identity.operationId().equals(UUID.fromString(identity.operationId()).toString())
                && identity.operationId().equals(retirement) && "DRAINING".equals(identity.phase()) && identity.phase().equals(phase)
                && identity.physicalKey().matches("[0-9a-f]{64}") && identity.physicalKey().equals(physical)
                && identity.sealedBindingVersion() > 0 && identity.sealedBindingVersion() <= original.version());
        return identity;
    }

    private static void verifyAssociation(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            Identity identity) throws SQLException, IOException {
        verifyImmutableAssociation(connection, original, identity, JdbcCsiActivationAdmission.JournalRead.LIVE);
        Reservation reservation = identity.reservation();
        try (PreparedStatement statement = statement(connection,
                "SELECT storage_kind, csi_phase, csi_revision, csi_reservation_id, csi_registration_key,"
                        + " csi_registration_revision, binding_id, runtime_generation, csi_provision_request_id"
                        + " FROM managed_workspace_execution_lease WHERE storage_key = ? FOR UPDATE")) {
            statement.setString(1, identity.physicalKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && "CSI".equals(row.getString("storage_kind"))
                        && "DRAINING".equals(row.getString("csi_phase"))
                        && row.getLong("csi_revision") == CsiOwnershipRevision.next(reservation.revision())
                        && reservation.reservationId().equals(row.getString("csi_reservation_id"))
                        && reservation.registrationKey().equals(row.getString("csi_registration_key"))
                        && reservation.registrationRevision() == row.getLong("csi_registration_revision")
                        && original.bindingId().equals(row.getString("binding_id"))
                        && original.generation() == row.getLong("runtime_generation")
                        && Objects.equals(reservation.provisionRequestId(), row.getString("csi_provision_request_id")));
                require(!row.next());
            }
        }
    }

    private static void verifyImmutableAssociation(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            Identity identity, JdbcCsiActivationAdmission.JournalRead read) throws SQLException, IOException {
        Reservation reservation = identity.reservation();
        require("RESERVED".equals(reservation.phase()) && CsiOwnershipRevision.reserved(reservation.revision())
                && reservation.reservationId().equals(UUID.fromString(reservation.reservationId()).toString())
                && original.bindingId().equals(reservation.bindingId())
                && original.generation() == reservation.runtimeGeneration()
                && identity.leaseDigest().matches("[0-9a-f]{64}"));
        Instant.parse(identity.startedAt());
        try (PreparedStatement statement = read.statement(connection,
                "SELECT provisioner_kind, provision_request_id, resource_handle_version, resource_handle_json,"
                        + " runtime_instance_id, runtime_lease_id, runtime_epoch, attestation_generation"
                        + " FROM qwen_runtime_binding WHERE binding_id = ?")) {
            statement.setString(1, original.bindingId());
            try (var row = statement.executeQuery()) {
                require(row.next() && identity.resourceHandleKind().equals(row.getString("provisioner_kind"))
                        && identity.resourceHandleVersion() > 0
                        && identity.resourceHandleVersion() == row.getInt("resource_handle_version")
                        && JSON.readTree(identity.resourceHandleJson()).equals(JSON.readTree(row.getString("resource_handle_json")))
                        && identity.runtimeInstanceId().equals(row.getString("runtime_instance_id"))
                        && identity.leaseId().equals(row.getString("runtime_lease_id"))
                        && identity.epoch() > 0 && identity.epoch() == row.getLong("runtime_epoch")
                        && identity.attestationGeneration() > 0
                        && identity.attestationGeneration() == row.getLong("attestation_generation")
                        && reservation.provisionRequestId().equals(row.getString("provision_request_id")));
                require(!row.next());
            }
        }
        try (PreparedStatement statement = read.statement(connection,
                "SELECT tenant_id, storage_id, physical_key, registration_revision"
                        + " FROM managed_workspace_csi_registration WHERE alias_key = ?")) {
            statement.setString(1, reservation.registrationKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getTenantId().equals(row.getString("tenant_id"))
                        && original.request().getStorageId().equals(row.getString("storage_id"))
                        && identity.physicalKey().equals(row.getString("physical_key"))
                        && reservation.registrationRevision() > 0
                        && reservation.registrationRevision() == row.getLong("registration_revision"));
                require(!row.next());
            }
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_retirement_identity_unavailable",
                "The original CSI retirement authorization ceiling is unavailable.", false);
    }

    private record Reservation(String phase, long revision, String reservationId, String registrationKey,
            long registrationRevision, String bindingId, long runtimeGeneration, String provisionRequestId) {
    }

    private record Identity(String operationId, String physicalKey, String phase, Reservation reservation,
            long sealedBindingVersion, String resourceHandleKind, int resourceHandleVersion, String resourceHandleJson,
            String runtimeInstanceId, String leaseId, long epoch, String leaseDigest, long attestationGeneration,
            String startedAt) {
    }
}
