package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Private persistence only; a reservation does not authorize a mount. */
public final class WorkspaceCsiReservationStore {
    public static final String PROVISIONER_KIND = "kubernetes-workspace";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json;

    public record Reservation(String phase, long revision, String reservationId,
            String registrationKey, Long registrationRevision, String bindingId,
            Long runtimeGeneration, String provisionRequestId) {
    }

    public record Retirement(String operationId, String physicalKey, String phase,
            Reservation reservation, long sealedBindingVersion, String resourceHandleKind,
            Integer resourceHandleVersion, String resourceHandleJson, String runtimeInstanceId,
            String leaseId, Long epoch, String leaseDigest, long attestationGeneration, String startedAt) {
    }

    public WorkspaceCsiReservationStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ObjectMapper json) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
        this.json = json.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    public void register(WorkspaceCsiRegistration registration) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw unavailable();
        }
        String encoded;
        try {
            encoded = json.writeValueAsString(registration);
        } catch (JsonProcessingException error) {
            throw unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, registration.tenantId());
            if (jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease WHERE storage_key = ?",
                    Long.class, WorkspaceStorageKindGuard.localKey(registration.tenantId(), registration.storageId())) != 0) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO managed_workspace_csi_registration"
                    + " (alias_key, tenant_id, storage_id, physical_key, registration_revision, registration_json)"
                    + " VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE alias_key = alias_key",
                    registration.aliasKey(), registration.tenantId(), registration.storageId(),
                    registration.physicalKey(), registration.revision(), encoded);
            verifyRegistration(registration);
            jdbc.update("INSERT INTO managed_workspace_execution_lease (storage_key, storage_kind)"
                    + " VALUES (?, 'CSI') ON DUPLICATE KEY UPDATE storage_key = storage_key",
                    registration.physicalKey());
            readReservation(registration.physicalKey());
        });
    }

    public Reservation inspect(WorkspaceCsiRegistration registration) {
        return transaction.execute(status -> {
            verifyRegistration(registration);
            return readReservation(registration.physicalKey());
        });
    }

    public Reservation reserve(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original, String reservationId) {
        if (bindings == null || original == null || original.getState() != RuntimeBindingRecord.State.PROVISIONING
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || original.getOperationOwner() == null || original.isDrainRequested()
                || !uuid(reservationId)) {
            throw unavailable();
        }
        return transaction.execute(status -> {
            RuntimeBindingRecord authoritative;
            try {
                authoritative = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.findByIdForUpdate(connection, original.getBindingId()));
            } catch (IllegalArgumentException | IllegalStateException error) {
                throw unavailable();
            }
            Instant operationUntil = verifyBinding(registration, original, authoritative);
            verifyRegistration(registration);
            Reservation current = readReservation(registration.physicalKey());
            Instant now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))", (row, index) ->
                            Instant.ofEpochSecond(row.getLong(1), row.getLong(2) * 1000));
            if (now == null || !operationUntil.isAfter(now)) {
                throw unavailable();
            }
            String requestId = original.getProvisionSeed().getProvisionRequestId();
            if ("RESERVED".equals(current.phase())) {
                if (!reservationId.equals(current.reservationId())
                        || !registration.aliasKey().equals(current.registrationKey())
                        || !Objects.equals(registration.revision(), current.registrationRevision())
                        || !original.getBindingId().equals(current.bindingId())
                        || !Objects.equals(original.getGeneration(), current.runtimeGeneration())
                        || !requestId.equals(current.provisionRequestId())) {
                    throw busy();
                }
                return current;
            }
            if (!"RELEASED".equals(current.phase())) {
                throw busy();
            }
            int changed = jdbc.update("UPDATE managed_workspace_execution_lease"
                    + " SET csi_phase = 'RESERVED', csi_revision = csi_revision + 1,"
                    + " csi_reservation_id = ?, csi_registration_key = ?, csi_registration_revision = ?,"
                    + " binding_id = ?, runtime_generation = ?, csi_provision_request_id = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RELEASED'"
                    + " AND csi_revision = ? AND holder_key IS NULL AND runtime_session_id IS NULL",
                    reservationId, registration.aliasKey(), registration.revision(), original.getBindingId(),
                    original.getGeneration(), requestId, registration.physicalKey(), current.revision());
            if (changed != 1) {
                throw unavailable();
            }
            return readReservation(registration.physicalKey());
        });
    }

    public Retirement beginRetirement(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original,
            Reservation expected, String operationId) {
        requireRetirementInput(bindings, original);
        if (expected == null || !"RESERVED".equals(expected.phase()) || expected.revision() != 1
                || !uuid(operationId)) {
            throw unavailable();
        }
        return transaction.execute(status -> {
            RuntimeBindingRecord current = lockRetirementBinding(bindings, original);
            verifyRegistration(registration);
            Reservation holder = readReservation(registration.physicalKey());
            Retirement prior = readRetirement(current);
            if (prior != null) {
                verifyRetirement(prior, registration, current, holder);
                if (!operationId.equals(prior.operationId()) || !expected.equals(prior.reservation())) {
                    throw unavailable();
                }
                return prior;
            }
            if (!expected.equals(holder) || !matchesHolder(registration, current, holder)
                    || current.getVersion() != original.getVersion()
                    || current.getState() != original.getState()
                    || current.isDrainRequested()
                    || !current.hasSameLease(original.getLease())
                    || !Objects.equals(current.getResourceHandle(), original.getResourceHandle())
                    || !Objects.equals(current.getOperationOwner(), original.getOperationOwner())
                    || !Objects.equals(current.getOperationLeaseUntil(), original.getOperationLeaseUntil())
                    || current.getOperationGeneration() != original.getOperationGeneration()) {
                throw unavailable();
            }
            RuntimeBindingRecord sealed;
            try {
                sealed = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.sealForRetirement(connection, current));
            } catch (IllegalArgumentException | IllegalStateException error) {
                throw unavailable();
            }
            Retirement intent = snapshot(operationId, registration, sealed, expected);
            String encoded;
            try {
                encoded = json.writeValueAsString(intent);
            } catch (JsonProcessingException error) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO managed_workspace_csi_retirement"
                    + " (retirement_id, binding_id, runtime_generation, physical_key, phase, identity_json)"
                    + " VALUES (?, ?, ?, ?, 'DRAINING', ?)", operationId, current.getBindingId(),
                    current.getGeneration(), registration.physicalKey(), encoded);
            if (jdbc.update("UPDATE managed_workspace_execution_lease"
                    + " SET csi_phase = 'DRAINING', csi_revision = csi_revision + 1"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RESERVED'"
                    + " AND csi_revision = ? AND csi_reservation_id = ?",
                    registration.physicalKey(), expected.revision(), expected.reservationId()) != 1) {
                throw unavailable();
            }
            return intent;
        });
    }

    public Retirement inspectRetirement(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original) {
        requireRetirementInput(bindings, original);
        return transaction.execute(status -> {
            RuntimeBindingRecord current = lockRetirementBinding(bindings, original);
            verifyRegistration(registration);
            Reservation holder = readReservation(registration.physicalKey());
            Retirement intent = readRetirement(current);
            if (intent != null) {
                verifyRetirement(intent, registration, current, holder);
            } else if (!matchesHolder(registration, current, holder)
                    || !"RESERVED".equals(holder.phase()) || current.isDrainRequested()) {
                throw unavailable();
            }
            return intent;
        });
    }

    record PublicationRuntime(RuntimeBindingRecord binding, Retirement retirement) {
    }

    PublicationRuntime lockPublication(JdbcRuntimeBindingRepository bindings,
            RuntimeBindingRecord original) {
        if (!TransactionSynchronizationManager.isActualTransactionActive() || bindings == null
                || !bindings.usesDataSource(jdbc.getDataSource()) || original == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null) {
            throw unavailable();
        }
        RuntimeBindingRecord current = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection -> {
            var target = DataSourceUtils.getTargetConnection(connection);
            if (!DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource())) {
                throw unavailable();
            }
            return bindings.lockActiveForRetirement(target, original);
        });
        WorkspaceCsiRegistration registration = readRegistration(WorkspaceCsiRegistration.aliasKey(
                current.getRequest().getScope().getTenantId(), current.getRequest().getStorageId()));
        Reservation holder = readReservation(registration.physicalKey());
        Retirement intent = readRetirement(current);
        if (current.getState() == RuntimeBindingRecord.State.READY && !current.isDrainRequested()) {
            if (intent != null || !"RESERVED".equals(holder.phase())
                    || !matchesHolder(registration, current, holder)) {
                throw unavailable();
            }
        } else {
            if (intent == null) {
                throw unavailable();
            }
            verifyRetirement(intent, registration, current, holder);
        }
        return new PublicationRuntime(current, intent);
    }

    private void requireRetirementInput(JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original) {
        if (TransactionSynchronizationManager.isActualTransactionActive() || bindings == null
                || !bindings.usesDataSource(jdbc.getDataSource()) || original == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null) {
            throw unavailable();
        }
    }

    private RuntimeBindingRecord lockRetirementBinding(JdbcRuntimeBindingRepository bindings,
            RuntimeBindingRecord original) {
        try {
            return jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                    bindings.lockActiveForRetirement(connection, original));
        } catch (IllegalArgumentException | IllegalStateException error) {
            throw unavailable();
        }
    }

    private Retirement readRetirement(RuntimeBindingRecord binding) {
        List<Retirement> rows = jdbc.query("SELECT * FROM managed_workspace_csi_retirement"
                + " WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE", (row, index) -> {
                    String encoded = row.getString("identity_json");
                    if (encoded == null || encoded.length() > 256 * 1024) {
                        throw unavailable();
                    }
                    try {
                        Retirement value = json.readValue(encoded, Retirement.class);
                        if (!uuid(value.operationId()) || !value.operationId().equals(row.getString("retirement_id"))
                                || !"DRAINING".equals(value.phase()) || !value.phase().equals(row.getString("phase"))
                                || !value.physicalKey().equals(row.getString("physical_key"))
                                || !binding.getBindingId().equals(row.getString("binding_id"))
                                || binding.getGeneration() != row.getLong("runtime_generation")) {
                            throw unavailable();
                        }
                        return value;
                    } catch (JsonProcessingException | NullPointerException error) {
                        throw unavailable();
                    }
                }, binding.getBindingId(), binding.getGeneration());
        if (rows.size() > 1) {
            throw unavailable();
        }
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private void verifyRetirement(Retirement intent, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation holder) {
        Reservation original = intent.reservation();
        if (original == null || !"RESERVED".equals(original.phase()) || original.revision() != 1
                || !matchesHolder(registration, binding, original)
                || !"DRAINING".equals(holder.phase()) || holder.revision() != original.revision() + 1
                || !holder.equals(new Reservation("DRAINING", original.revision() + 1,
                        original.reservationId(), original.registrationKey(), original.registrationRevision(),
                        original.bindingId(), original.runtimeGeneration(), original.provisionRequestId()))
                || binding.getState() != RuntimeBindingRecord.State.DRAINING || !binding.isDrainRequested()
                || intent.sealedBindingVersion() <= 0 || binding.getVersion() < intent.sealedBindingVersion()
                || !intent.physicalKey().equals(registration.physicalKey())
                || !intent.equals(snapshot(intent.operationId(), registration, binding, original,
                        intent.sealedBindingVersion(), intent.startedAt()))) {
            throw unavailable();
        }
    }

    private Retirement snapshot(String operationId, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation reservation) {
        return snapshot(operationId, registration, binding, reservation, binding.getVersion(),
                jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                        (row, index) -> Instant.ofEpochSecond(row.getLong(1), row.getLong(2) * 1000).toString()));
    }

    private Retirement snapshot(String operationId, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation reservation, long version, String startedAt) {
        var handle = binding.getResourceHandle();
        var lease = binding.getLease();
        try {
            if (startedAt == null) {
                throw unavailable();
            }
            Instant.parse(startedAt);
            return new Retirement(operationId, registration.physicalKey(), "DRAINING", reservation, version,
                    handle == null ? null : handle.getKind(), handle == null ? null : handle.getVersion(),
                    handle == null ? null : json.writeValueAsString(handle.getValue()),
                    lease == null ? null : lease.getRuntimeInstanceId(), lease == null ? null : lease.getLeaseId(),
                    lease == null ? null : lease.getEpoch(), leaseDigest(lease), binding.getAttestationGeneration(), startedAt);
        } catch (JsonProcessingException | java.time.format.DateTimeParseException error) {
            throw unavailable();
        }
    }

    private String leaseDigest(com.alibaba.qwen.code.runtimebroker.RuntimeLease lease) {
        if (lease == null) {
            return null;
        }
        try {
            byte[] identity = json.writeValueAsBytes(List.of("qwen-csi-retirement-lease/1",
                    lease.getRuntimeInstanceId(), lease.getEndpoint().toString(), lease.getToken(),
                    lease.getLeaseId(), Long.toString(lease.getEpoch())));
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(identity));
        } catch (JsonProcessingException | java.security.NoSuchAlgorithmException error) {
            throw unavailable();
        }
    }

    private static boolean matchesHolder(WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation holder) {
        return registration.tenantId().equals(binding.getRequest().getScope().getTenantId())
                && registration.storageId().equals(binding.getRequest().getStorageId())
                && registration.mountRoot().equals(binding.getRequest().getScope().getCanonicalCwd())
                && registration.aliasKey().equals(holder.registrationKey())
                && Objects.equals(registration.revision(), holder.registrationRevision())
                && binding.getBindingId().equals(holder.bindingId())
                && Objects.equals(binding.getGeneration(), holder.runtimeGeneration())
                && binding.getProvisionSeed().getProvisionRequestId().equals(holder.provisionRequestId());
    }

    private void verifyRegistration(WorkspaceCsiRegistration expected) {
        if (!expected.equals(readRegistration(expected.aliasKey()))) {
            throw unavailable();
        }
    }

    private WorkspaceCsiRegistration readRegistration(String aliasKey) {
        List<WorkspaceCsiRegistration> exact = jdbc.query("SELECT * FROM managed_workspace_csi_registration"
                + " WHERE alias_key = ? FOR UPDATE", (row, index) -> {
                    String encoded = row.getString("registration_json");
                    if (encoded == null || encoded.length() > 16 * 1024) {
                        throw unavailable();
                    }
                    try {
                        WorkspaceCsiRegistration actual = json.readValue(encoded, WorkspaceCsiRegistration.class);
                        if (!actual.aliasKey().equals(row.getString("alias_key"))
                                || !actual.tenantId().equals(row.getString("tenant_id"))
                                || !actual.storageId().equals(row.getString("storage_id"))
                                || !actual.physicalKey().equals(row.getString("physical_key"))
                                || actual.revision() != row.getLong("registration_revision")) {
                            throw unavailable();
                        }
                        return actual;
                    } catch (JsonProcessingException | IllegalArgumentException error) {
                        throw unavailable();
                    }
                }, aliasKey);
        if (exact.size() != 1) {
            throw unavailable();
        }
        return exact.getFirst();
    }

    private Reservation readReservation(String physicalKey) {
        List<Reservation> rows = jdbc.query("SELECT * FROM managed_workspace_execution_lease"
                + " WHERE storage_key = ? FOR UPDATE", (row, index) -> {
                    Reservation value = new Reservation(row.getString("csi_phase"), row.getLong("csi_revision"),
                            row.getString("csi_reservation_id"), row.getString("csi_registration_key"),
                            row.getObject("csi_registration_revision", Long.class), row.getString("binding_id"),
                            row.getObject("runtime_generation", Long.class), row.getString("csi_provision_request_id"));
                    boolean released = "RELEASED".equals(value.phase()) && value.revision() == 0
                            && value.reservationId() == null && value.registrationKey() == null
                            && value.registrationRevision() == null && value.bindingId() == null
                            && value.runtimeGeneration() == null && value.provisionRequestId() == null;
                    boolean reserved = ("RESERVED".equals(value.phase()) && value.revision() == 1
                            || "DRAINING".equals(value.phase()) && value.revision() == 2)
                            && uuid(value.reservationId()) && value.registrationKey() != null
                            && value.registrationRevision() != null && value.registrationRevision() > 0
                            && value.bindingId() != null && value.runtimeGeneration() != null
                            && value.runtimeGeneration() > 0 && value.provisionRequestId() != null;
                    if (!"CSI".equals(row.getString("storage_kind")) || row.getString("holder_key") != null
                            || row.getString("runtime_session_id") != null || (!released && !reserved)) {
                        throw unavailable();
                    }
                    return value;
                }, physicalKey);
        if (rows.size() != 1) {
            throw unavailable();
        }
        return rows.getFirst();
    }

    private static Instant verifyBinding(WorkspaceCsiRegistration registration, RuntimeBindingRecord original,
            RuntimeBindingRecord authoritative) {
        var request = original.getRequest();
        var scope = request.getScope();
        if (!registration.tenantId().equals(scope.getTenantId())
                || !registration.storageId().equals(request.getStorageId())
                || !registration.mountRoot().equals(scope.getCanonicalCwd())
                || authoritative == null || !request.equals(authoritative.getRequest())
                || !original.getProvisionSeed().equals(authoritative.getProvisionSeed())
                || original.getGeneration() != authoritative.getGeneration()
                || authoritative.getState() != RuntimeBindingRecord.State.PROVISIONING
                || authoritative.isDrainRequested()
                || !authoritative.hasSameLease(original.getLease())
                || !Objects.equals(original.getResourceHandle(), authoritative.getResourceHandle())
                || !original.getOperationOwner().equals(authoritative.getOperationOwner())
                || original.getOperationGeneration() != authoritative.getOperationGeneration()
                || authoritative.getOperationLeaseUntil() == null) {
            throw unavailable();
        }
        return authoritative.getOperationLeaseUntil();
    }

    private static boolean uuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_csi_unavailable", "Workspace CSI admission is unavailable.", false);
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_csi_busy", "Workspace storage is reserved.", true);
    }
}
