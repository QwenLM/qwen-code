package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.transport.CsiCreationContract;
import com.alibaba.qwen.code.runtimebroker.transport.CsiInstalledByteObservation;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceJournal;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

/** Saves the original source before scheduling; immutable publication never proves release. */
public final class WorkspaceCsiNodeSourceStore {
    public static final int CONFIGURATION_LIMIT = 64 * 1024;
    public static final int EVIDENCE_LIMIT = 1024 * 1024;
    private static final JsonMapper JSON = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final JdbcTemplate jdbc;
    private final JdbcRuntimeBindingRepository bindings;
    private final TransactionTemplate transaction;

    /** Reviewed data expectations; these inputs alone never qualify an installation. */
    public record BirthInputs(String shimSha256, String runcSha256, String sandboxImageSha256, String creationContract) {
        public BirthInputs {
            require(shimSha256 != null && shimSha256.matches("[0-9a-f]{64}")
                    && runcSha256 != null && runcSha256.matches("[0-9a-f]{64}")
                    && sandboxImageSha256 != null && sandboxImageSha256.matches("[0-9a-f]{64}")
                    && creationContract != null && creationContract.length() <= (CsiCreationContract.LIMIT + 2) / 3 * 4);
            byte[] raw = Base64.getDecoder().decode(creationContract);
            require(creationContract.equals(Base64.getEncoder().encodeToString(raw)));
            CsiCreationContract.validate(raw);
        }
    }

    /** Independent reviewed metadata, not values learned from the observed stream. */
    public record InstalledBytes(CsiInstalledByteObservation source, CsiInstalledByteObservation gateway,
            String kubeletSha256, String registrarSha256) {
        public InstalledBytes {
            CsiInstalledByteObservation.requirePair(source, gateway);
            require(kubeletSha256 != null && kubeletSha256.matches("[0-9a-f]{64}")
                    && registrarSha256 != null && registrarSha256.matches("[0-9a-f]{64}")
                    && !kubeletSha256.equals(registrarSha256));
        }
    }

    public record Node(String name, String incarnation, CsiNodeSourceJournal.SourceIdentity identity,
            URI sourceOrigin, String sourcePrincipal, URI gatewayOrigin, String gatewayPrincipal, String workerPolicySha256,
            BirthInputs birthInputs, InstalledBytes installedBytes) {
        public Node {
            require(name != null && name.matches("[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?")
                    && incarnation != null && incarnation.matches("[0-9a-f]{32}") && identity != null
                    && sourceOrigin != null && gatewayOrigin != null && !sourceOrigin.equals(gatewayOrigin)
                    && sourcePrincipal != null && gatewayPrincipal != null && !sourcePrincipal.equals(gatewayPrincipal)
                    && workerPolicySha256 != null && workerPolicySha256.matches("[0-9a-f]{64}") && birthInputs != null
                    && installedBytes != null && workerPolicySha256.equals(installedBytes.source().packedSha256())
                    && installedBytes.source().equals(identity.sourceArtifacts())
                    && installedBytes.gateway().equals(identity.gatewayArtifacts()));
        }
    }

    public record Configuration(Node node, String imageDigest, CsiNodeSourceJournal.Scope scope) {
        public Configuration {
            require(node != null && imageDigest != null && imageDigest.matches("[0-9a-f]{64}") && scope != null
                    && scope.podUid().isEmpty() && scope.containerId().isEmpty() && scope.target().isEmpty()
                    && scope.retirementId().isEmpty());
        }
    }

    public record Association(String bindingId, long generation, String physicalKey, String reservationId,
            long reservationRevision, Configuration configuration, String phase, long version,
            CsiNodeSourceJournal.Evidence arm, String podUid, String gatedSpecSha256,
            CsiNodeSourceJournal.Evidence bound, CsiNodeSourceJournal.Evidence publication) { }

    public WorkspaceCsiNodeSourceStore(JdbcTemplate jdbc, DataSourceTransactionManager manager,
            JdbcRuntimeBindingRepository bindings) {
        require(jdbc != null && manager != null && bindings != null && jdbc.getDataSource() == manager.getDataSource());
        this.jdbc = jdbc;
        this.bindings = bindings;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
    }

    static Association lockedPublication(Connection connection, String bindingId) throws SQLException {
        require(connection != null && !connection.getAutoCommit());
        var result = read(connection, bindingId, true);
        require(result != null && "PUBLISHED".equals(result.phase()));
        return result;
    }

    static void requireOriginalPublication(Connection connection, RuntimeBindingRecord binding,
            WorkspaceCsiRegistration registration, WorkspaceCsiReservationStore.Reservation holder) throws SQLException {
        var source = lockedPublication(connection, binding.getBindingId());
        var observed = validateEvidence(source.configuration(), source.publication(), "PUBLISHED", source.podUid());
        var placement = com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map(binding.getResourceHandle().getValue().get("placement"));
        require(holder != null && binding.getGeneration() == source.generation() && registration.physicalKey().equals(source.physicalKey())
                && holder.reservationId().equals(source.reservationId()) && holder.revision() == source.reservationRevision()
                && source.podUid().equals(placement.get("podUid"))
                && source.configuration().node().name().equals(placement.get("nodeName"))
                && source.configuration().node().identity().nodeUid().equals(placement.get("nodeUid"))
                && ("containerd://" + observed.scope().containerId()).equals(placement.get("containerId"))
                && source.configuration().scope().namespace().equals(placement.get("namespace"))
                && source.configuration().scope().podName().equals(placement.get("podName"))
                && placement.get("image") instanceof String image && image.endsWith("@sha256:" + source.configuration().imageDigest())
                && registration.namespace().equals(observed.scope().namespace()) && registration.driver().equals(observed.scope().driver())
                && registration.volumeHandle().equals(observed.scope().volumeId()) && registration.pvUid().equals(observed.scope().pvUid())
                && registration.pvcUid().equals(observed.scope().pvcUid())
                && ("/var/lib/kubelet/pods/" + source.podUid() + "/volumes/kubernetes.io~csi/" + registration.pvName() + "/mount")
                        .equals(observed.scope().target()));
    }

    public Association inspect(String bindingId) {
        return jdbc.execute((ConnectionCallback<Association>) connection -> read(connection, bindingId, false));
    }

    static boolean hasAssociation(Connection connection, String bindingId, String physicalKey, boolean lock) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT binding_id FROM ma_csi_source"
                + " WHERE binding_id = ? OR physical_key = ? LIMIT 1" + (lock ? " FOR UPDATE" : ""))) {
            statement.setQueryTimeout(10);
            statement.setBytes(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(bindingId));
            statement.setString(2, physicalKey);
            try (var row = statement.executeQuery()) {
                return row.next();
            }
        }
    }

    public void saveArm(RuntimeBindingRecord original, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, Configuration configuration,
            CsiNodeSourceJournal.Evidence evidence) {
        require(original != null && registration != null && configuration != null
                && original.getBindingId().equals(configuration.scope().bindingId())
                && com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.name(original.getProvisionSeed()).equals(configuration.scope().podName())
                && registration.namespace().equals(configuration.scope().namespace())
                && registration.driver().equals(configuration.scope().driver()) && registration.volumeHandle().equals(configuration.scope().volumeId())
                && registration.pvUid().equals(configuration.scope().pvUid()) && registration.pvcUid().equals(configuration.scope().pvcUid()));
        validateEvidence(configuration, evidence, "ARMED", null);
        String encoded = encode(configuration);
        mutate(original, registration, reservation, connection -> {
            Association previous = read(connection, original.getBindingId(), true);
            if (previous != null) {
                require(previous.phase().equals("ARMED") && previous.configuration().equals(configuration)
                        && java.util.Arrays.equals(previous.arm().bytes(), evidence.bytes()));
                return;
            }
            jdbc.update("INSERT INTO ma_csi_source (binding_id, runtime_generation, physical_key,"
                    + " reservation_id, reservation_revision, configuration_json, phase, record_version,"
                    + " arm_bytes, arm_sequence, arm_hash) VALUES (?, ?, ?, ?, ?, ?, 'ARMED', 1, ?, ?, ?)",
                    original.getBindingId(), original.getGeneration(), registration.physicalKey(), reservation.reservationId(),
                    reservation.revision(), encoded, evidence.bytes(), evidence.stream().head().sequence(), evidence.stream().head().hash());
        });
    }

    public void saveBound(RuntimeBindingRecord original, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, Association expected, String podUid,
            String gatedSpecSha256, String podResourceVersion, CsiNodeSourceJournal.Evidence evidence) {
        require(expected != null && "ARMED".equals(expected.phase()) && podUid != null
                && java.util.UUID.fromString(podUid).toString().equals(podUid)
                && gatedSpecSha256 != null && gatedSpecSha256.matches("[0-9a-f]{64}"));
        evidence.requireExtends(expected.arm());
        validateEvidence(expected.configuration(), evidence, "BOUND", podUid);
        var observation = evidence.stream().observations().stream().filter(value -> value.scope().armId().equals(expected.configuration().scope().armId())).findFirst().orElseThrow();
        var bind = evidence.record(observation.bound());
        require(gatedSpecSha256.equals(bind.path("gatedSpecSha256").textValue())
                && podResourceVersion != null && podResourceVersion.equals(bind.path("podResourceVersion").textValue()));
        mutate(original, registration, reservation, connection -> {
            Association current = read(connection, original.getBindingId(), true);
            requireSame(current, expected);
            require(jdbc.update("UPDATE ma_csi_source SET phase = 'BOUND', record_version = 2,"
                    + " pod_uid = ?, gated_spec_sha256 = ?, bound_bytes = ?, bound_sequence = ?, bound_hash = ?"
                    + " WHERE binding_id = ? AND phase = 'ARMED' AND record_version = 1", podUid, gatedSpecSha256,
                    evidence.bytes(), evidence.stream().head().sequence(), evidence.stream().head().hash(), original.getBindingId()) == 1);
        });
    }

    public void savePublication(RuntimeBindingRecord original, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, Association expected,
            CsiNodeSourceJournal.Evidence evidence) {
        require(expected != null && "BOUND".equals(expected.phase()));
        evidence.requireExtends(expected.bound());
        validateEvidence(expected.configuration(), evidence, "PUBLISHED", expected.podUid());
        mutate(original, registration, reservation, connection -> {
            Association current = read(connection, original.getBindingId(), true);
            requireSame(current, expected);
            require(jdbc.update("UPDATE ma_csi_source SET phase = 'PUBLISHED', record_version = 3,"
                    + " publication_bytes = ?, publication_sequence = ?, publication_hash = ?"
                    + " WHERE binding_id = ? AND phase = 'BOUND' AND record_version = 2", evidence.bytes(),
                    evidence.stream().head().sequence(), evidence.stream().head().hash(), original.getBindingId()) == 1);
        });
    }

    private void mutate(RuntimeBindingRecord original, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation, Mutation mutation) {
        require(!TransactionSynchronizationManager.isActualTransactionActive() && original != null
                && registration != null && reservation != null && "RESERVED".equals(reservation.phase())
                && reservation.revision() == 1);
        long started = System.nanoTime();
        transaction.executeWithoutResult(status -> jdbc.execute((ConnectionCallback<Void>) actual -> {
            Connection connection = bounded(actual, started);
            var control = JdbcCsiFilesRetirementGuard.lockBindingControl(connection, original.getBindingId());
            require(control != null && control.generation() == 1 && control.state() == RuntimeBindingRecord.State.PROVISIONING
                    && !control.draining() && original.getRequest().equals(control.request()));
            var current = bindings.findByIdForUpdate(connection, original.getBindingId());
            require(current != null && current.getVersion() >= original.getVersion()
                    && current.getGeneration() == original.getGeneration() && current.getProvisionSeed().equals(original.getProvisionSeed())
                    && current.getState() == original.getState() && current.isDrainRequested() == original.isDrainRequested()
                    && current.hasSameLease(original.getLease()) && Objects.equals(current.getResourceHandle(), original.getResourceHandle())
                    && current.getAttestationGeneration() == original.getAttestationGeneration()
                    && Objects.equals(current.getLastHealthAt(), original.getLastHealthAt())
                    && Objects.equals(current.getLastReconciledAt(), original.getLastReconciledAt())
                    && Objects.equals(current.getLastActiveAt(), original.getLastActiveAt())
                    && Objects.equals(current.getLossEvidence(), original.getLossEvidence())
                    && Objects.equals(current.getStopEvidence(), original.getStopEvidence())
                    && Objects.equals(current.getDrainReceipt(), original.getDrainReceipt())
                    && original.getOperationOwner() != null
                    && Objects.equals(current.getOperationOwner(), original.getOperationOwner())
                    && current.getOperationGeneration() == original.getOperationGeneration()
                    && current.getOperationLeaseUntil() != null && current.getOperationLeaseUntil().isAfter(databaseNow()));
            try (var alias = connection.prepareStatement("SELECT registration_json FROM ma_storage WHERE alias_key = ? AND storage_kind = 'CSI' AND registration_state = 'REGISTERED' FOR UPDATE")) {
                alias.setQueryTimeout(10);
                alias.setString(1, registration.aliasKey());
                try (var row = alias.executeQuery()) {
                    require(row.next() && registration.equals(decode(row.getString(1), WorkspaceCsiRegistration.class)) && !row.next());
                }
            }
            try (var holder = connection.prepareStatement("SELECT * FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
                holder.setQueryTimeout(10);
                holder.setString(1, registration.physicalKey());
                try (var row = holder.executeQuery()) {
                    require(row.next() && "CSI".equals(row.getString("storage_kind")) && "RESERVED".equals(row.getString("csi_phase"))
                            && row.getLong("csi_revision") == reservation.revision()
                            && reservation.reservationId().equals(row.getString("csi_reservation_id"))
                            && registration.aliasKey().equals(row.getString("csi_registration_key"))
                            && registration.revision() == row.getLong("csi_registration_revision")
                            && original.getBindingId().equals(row.getString("binding_id"))
                            && original.getGeneration() == row.getLong("runtime_generation")
                            && original.getProvisionSeed().getProvisionRequestId().equals(row.getString("csi_provision_request_id")) && !row.next());
                }
            }
            require(current.getOperationLeaseUntil().isAfter(databaseNow()));
            mutation.apply(connection);
            require(current.getOperationLeaseUntil().isAfter(databaseNow()));
            return null;
        }));
    }

    private java.time.Instant databaseNow() {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> java.time.Instant.ofEpochSecond(row.getLong(1), row.getLong(2) * 1000));
    }

    private static Association read(Connection connection, String bindingId, boolean lock) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT * FROM ma_csi_source WHERE binding_id = ?" + (lock ? " FOR UPDATE" : ""))) {
            statement.setQueryTimeout(10);
            statement.setBytes(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(bindingId));
            try (var row = statement.executeQuery()) {
                if (!row.next()) {
                    return null;
                }
                var configuration = decode(row.getString("configuration_json"), Configuration.class);
                var association = new Association(row.getString("binding_id"), row.getLong("runtime_generation"), row.getString("physical_key"),
                        row.getString("reservation_id"), row.getLong("reservation_revision"), configuration,
                        row.getString("phase"), row.getLong("record_version"), evidence(row, "arm", true),
                        row.getString("pod_uid"), row.getString("gated_spec_sha256"), evidence(row, "bound", false), evidence(row, "publication", false));
                validate(association);
                require(!row.next());
                return association;
            }
        }
    }

    public static void validate(Association value) {
        require(value != null && value.generation() == 1 && value.physicalKey().matches("[0-9a-f]{64}")
                && value.reservationRevision() == 1
                && java.util.UUID.fromString(value.reservationId()).toString().equals(value.reservationId())
                && value.bindingId().equals(value.configuration().scope().bindingId()));
        validateEvidence(value.configuration(), value.arm(), "ARMED", null);
        if ("ARMED".equals(value.phase())) {
            require(value.version() == 1 && value.podUid() == null && value.gatedSpecSha256() == null
                    && value.bound() == null && value.publication() == null);
            return;
        }
        require(value.podUid() != null && java.util.UUID.fromString(value.podUid()).toString().equals(value.podUid())
                && value.gatedSpecSha256() != null && value.gatedSpecSha256().matches("[0-9a-f]{64}") && value.bound() != null);
        value.bound().requireExtends(value.arm());
        validateEvidence(value.configuration(), value.bound(), "BOUND", value.podUid());
        var boundObservation = value.bound().stream().observations().stream().filter(observed -> observed.scope().armId().equals(value.configuration().scope().armId())).findFirst().orElseThrow();
        require(value.gatedSpecSha256().equals(value.bound().record(boundObservation.bound()).path("gatedSpecSha256").textValue()));
        if ("BOUND".equals(value.phase())) {
            require(value.version() == 2 && value.publication() == null);
            return;
        }
        require("PUBLISHED".equals(value.phase()) && value.version() == 3 && value.publication() != null);
        value.publication().requireExtends(value.bound());
        validateEvidence(value.configuration(), value.publication(), "PUBLISHED", value.podUid());
    }

    public static CsiNodeSourceJournal.Observation validateEvidence(Configuration configuration,
            CsiNodeSourceJournal.Evidence evidence, String phase, String podUid) {
        require(configuration != null && phase != null && List.of("ARMED", "BOUND", "PUBLISHED").contains(phase)
                && evidence != null && evidence.bytes().length <= EVIDENCE_LIMIT
                && configuration.node().identity().equals(evidence.stream().source())
                && configuration.node().incarnation().equals(evidence.stream().incarnation()));
        var installed = configuration.node().installedBytes();
        require(installed.source().equals(evidence.stream().source().sourceArtifacts())
                && installed.gateway().equals(evidence.stream().source().gatewayArtifacts()));
        var matches = evidence.stream().observations().stream().filter(value -> value.scope().armId().equals(configuration.scope().armId())).toList();
        require(matches.size() == 1);
        var observation = matches.getFirst();
        var scope = observation.scope();
        var expected = configuration.scope();
        var armed = evidence.record(observation.arm());
        require(configuration.imageDigest().equals(armed.path("imageDigest").textValue())
                && configuration.node().workerPolicySha256().equals(armed.path("policy").path("rawSha256").textValue())
                && armed.path("policy").path("rawBytes").longValue() == installed.source().packedBytes()
                && installed.kubeletSha256().equals(armed.path("frontend").path("kubelet").path("digest").textValue())
                && installed.registrarSha256().equals(armed.path("frontend").path("registrar").path("digest").textValue()));
        require(scope.namespace().equals(expected.namespace()) && scope.podName().equals(expected.podName())
                && scope.bindingId().equals(expected.bindingId()) && scope.driver().equals(expected.driver())
                && scope.volumeId().equals(expected.volumeId()) && scope.pvUid().equals(expected.pvUid())
                && scope.pvcUid().equals(expected.pvcUid()) && scope.retirementId().isEmpty() && phase.equals(observation.state()));
        if ("ARMED".equals(phase)) {
            require(scope.equals(expected) && evidence.stream().head().equals(observation.arm()));
        } else {
            require(podUid.equals(scope.podUid()) && observation.bound() != null && !scope.target().isEmpty());
            if ("BOUND".equals(phase)) {
                require(scope.containerId().isEmpty() && observation.custody() == null && observation.publish() == null
                        && observation.intent() == null && evidence.stream().head().equals(observation.bound()));
            }
            if ("PUBLISHED".equals(phase)) {
                require(observation.custody() != null && observation.publish() != null && scope.containerId().matches("[0-9a-f]{64}"));
                require(configuration.imageDigest().equals(evidence.record(observation.custody()).path("runtime").path("imageDigest").textValue()));
                validateBirths(configuration, evidence, observation, true);
            }
        }
        return observation;
    }

    static void validateBirths(Configuration configuration, CsiNodeSourceJournal.Evidence evidence,
            CsiNodeSourceJournal.Observation observation, boolean published) {
        require(observation.births().size() == 2);
        var sandboxes = observation.births().stream().filter(value -> "sandbox".equals(value.role())).toList();
        var workers = observation.births().stream().filter(value -> "container".equals(value.role())).toList();
        require(sandboxes.size() == 1 && workers.size() == 1);
        var sandbox = sandboxes.getFirst();
        var worker = workers.getFirst();
        var inputs = configuration.node().birthInputs();
        require(sandbox.containerId().equals(sandbox.sandboxId()) && worker.sandboxId().equals(sandbox.containerId())
                && worker.containerId().equals(observation.scope().containerId())
                && configuration.imageDigest().equals(worker.imageDigest())
                && inputs.sandboxImageSha256().equals(sandbox.imageDigest()));
        for (var born : observation.births()) {
            require(born.prepared() != null && born.created() != null && born.startBegin() != null && born.started() != null
                    && (!published || born.deleted() == null));
            var birth = evidence.record(born.prepared()).path("birth");
            var policy = birth.path("policy");
            require(inputs.shimSha256().equals(birth.path("peer").path("executable").path("sha256").textValue())
                    && inputs.runcSha256().equals(policy.path("runcSha256").textValue())
                    && inputs.runcSha256().equals(birth.path("objects").get(4).path("sha256").textValue()));
            require(matchesFixedBirthPolicy(policy));
            try {
                CsiCreationContract.requireMatch(Base64.getDecoder().decode(inputs.creationContract()),
                        Base64.getDecoder().decode(birth.path("originalSpec").textValue()), born.containerId());
            } catch (IllegalArgumentException invalid) {
                throw unavailable();
            }
        }
    }

    static boolean matchesFixedBirthPolicy(com.fasterxml.jackson.databind.JsonNode policy) {
        return policy != null && "/run/containerd/io.containerd.runtime.v2.task/k8s.io".equals(policy.path("bundleRoot").textValue())
                && "/var/lib/qwen-k2/inputs".equals(policy.path("inputRoot").textValue())
                && "/opt/qwen-k2/bin/runc".equals(policy.path("runcPath").textValue())
                && "/run/qwen-k2/runc".equals(policy.path("runcRoot").textValue());
    }

    private static CsiNodeSourceJournal.Evidence evidence(ResultSet row, String prefix, boolean required) throws SQLException {
        byte[] bytes = row.getBytes(prefix + "_bytes");
        String hash = row.getString(prefix + "_hash");
        Long sequence = (Long) row.getObject(prefix + "_sequence");
        if (bytes == null) {
            require(!required && hash == null && sequence == null);
            return null;
        }
        require(sequence != null && bytes.length <= EVIDENCE_LIMIT);
        return CsiNodeSourceJournal.verify(bytes, new CsiNodeSourceJournal.Cursor(sequence, hash));
    }

    private static void requireSame(Association actual, Association expected) {
        require(actual != null && actual.bindingId().equals(expected.bindingId()) && actual.generation() == expected.generation()
                && actual.physicalKey().equals(expected.physicalKey()) && actual.reservationId().equals(expected.reservationId())
                && actual.reservationRevision() == expected.reservationRevision() && actual.configuration().equals(expected.configuration())
                && actual.phase().equals(expected.phase()) && actual.version() == expected.version()
                && Objects.equals(actual.podUid(), expected.podUid()) && Objects.equals(actual.gatedSpecSha256(), expected.gatedSpecSha256())
                && java.util.Arrays.equals(actual.arm().bytes(), expected.arm().bytes())
                && (actual.bound() == null ? expected.bound() == null : expected.bound() != null && java.util.Arrays.equals(actual.bound().bytes(), expected.bound().bytes())));
    }

    private static String encode(Object value) {
        try {
            String encoded = JSON.writeValueAsString(value);
            require(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= CONFIGURATION_LIMIT);
            return encoded;
        } catch (java.io.IOException error) {
            throw unavailable();
        }
    }

    public static <T> T decode(String value, Class<T> type) {
        require(value != null && value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length
                <= (type == Configuration.class ? CONFIGURATION_LIMIT : 16 * 1024));
        try {
            return JSON.readValue(value, type);
        } catch (java.io.IOException error) {
            throw unavailable();
        }
    }

    private static Connection bounded(Connection target, long started) {
        return (Connection) Proxy.newProxyInstance(WorkspaceCsiNodeSourceStore.class.getClassLoader(),
                new Class<?>[] {org.springframework.jdbc.datasource.ConnectionProxy.class}, (proxy, method, arguments) -> {
                    if (method.getName().equals("getTargetConnection")) {
                        return target;
                    }
                    try {
                        if (method.getName().equals("prepareStatement")) {
                            remaining(started);
                            var statement = (PreparedStatement) method.invoke(target, arguments);
                            statement.setQueryTimeout(remaining(started));
                            return Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {PreparedStatement.class},
                                    (prepared, operation, parameters) -> {
                                        try {
                                            if (operation.getName().equals("setQueryTimeout")) {
                                                statement.setQueryTimeout(Math.min((Integer) parameters[0], remaining(started)));
                                                return null;
                                            }
                                            if (operation.getName().startsWith("execute")) {
                                                statement.setQueryTimeout(remaining(started));
                                            }
                                            return operation.invoke(statement, parameters);
                                        } catch (InvocationTargetException failure) {
                                            throw failure.getCause();
                                        }
                                    });
                        }
                        return method.invoke(target, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static int remaining(long started) throws SQLException {
        long seconds = TimeUnit.NANOSECONDS.toSeconds(TimeUnit.SECONDS.toNanos(10) - (System.nanoTime() - started));
        if (seconds < 1) {
            throw new java.sql.SQLTimeoutException("Original CSI source transaction expired");
        }
        return Math.toIntExact(seconds);
    }

    private interface Mutation { void apply(Connection connection) throws SQLException; }
    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_node_source_association_unavailable", "The original CSI node source association is unavailable.", false);
    }
}
