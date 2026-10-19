package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiNodeEvidence;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceJournal;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceCsiNodeSourceStoreTest {
    private final ObjectMapper json = new ObjectMapper();
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private WorkspaceCsiRegistration registration;
    private WorkspaceCsiReservationStore.Reservation reservation;
    private WorkspaceCsiNodeSourceStore store;
    private JdbcRuntimeBindingRepository bindings;
    private RuntimeBindingRecord binding;
    private WorkspaceCsiNodeSourceStore.Configuration configuration;
    private CsiNodeSourceJournal.Evidence initial;
    private CsiNodeSourceJournal.Evidence arm;
    private CsiNodeSourceJournal.Evidence bound;
    private CsiNodeSourceJournal.Evidence publication;
    private final String podUid = "aa36d481-0995-4060-8ce7-f3d42c3e408f";

    @BeforeEach
    void setUp() throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:source-association-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "0c39f52b-120c-47fb-99bc-df907924af71",
                "pv", "3cfe8df0-ec94-465b-9e93-53c2491946a7", "diskplugin.csi.alibabacloud.com", "volume", "backend", "disk-serial", "/workspace", 7);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        reservations.register(registration);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'workspace', ?, 'OPERATOR')",
                ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        String session = WorkspaceCsiSessionMain.create(jdbc, manager, json, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null, new WorkspaceSelection("workspace", "."))).sessionId();
        var managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        var request = new TransactionTemplate(manager).execute(status -> managed.requireCsiRequest(registration, session));
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        String reservationId = UUID.nameUUIDFromBytes(("qwen-csi-reservation/1:" + registration.aliasKey() + ":"
                + registration.revision() + ":" + binding.getProvisionSeed().getProvisionRequestId()).getBytes(StandardCharsets.UTF_8)).toString();
        reservation = reservations.reserve(registration, bindings, binding, reservationId);
        store = new WorkspaceCsiNodeSourceStore(jdbc, manager, bindings);
        var protocol = protocol(binding, registration, reservation);
        initial = protocol.initial();
        arm = protocol.arm();
        bound = protocol.bound();
        publication = protocol.publication();
        configuration = protocol.configuration();
    }

    @Test
    void persistsAllOriginalPrefixesAndReadsThemAfterStoreRestart() {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var first = store.inspect(binding.getBindingId());
        store.saveBound(binding, registration, reservation, first, podUid, "a".repeat(64), "opaque:1", bound);
        var second = store.inspect(binding.getBindingId());
        store.savePublication(binding, registration, reservation, second, publication);
        var restarted = new WorkspaceCsiNodeSourceStore(jdbc, manager, bindings).inspect(binding.getBindingId());
        assertThat(restarted.phase()).isEqualTo("PUBLISHED");
        assertThat(restarted.version()).isEqualTo(3);
        assertThat(restarted.arm().bytes()).isEqualTo(arm.bytes());
        assertThat(restarted.bound().bytes()).isEqualTo(bound.bytes());
        assertThat(restarted.publication().bytes()).isEqualTo(publication.bytes());
        assertThat(restarted.configuration()).isEqualTo(configuration);
        assertThatThrownBy(() -> store.saveBound(binding, registration, reservation, first, podUid, "a".repeat(64), "opaque:1", bound))
                .hasMessageContaining("original CSI node source association");
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
    }

    @Test
    void legalOriginalGrantRenewalAllowsEveryAssociationStage() {
        for (int stage = 1; stage <= 3; stage++) {
            var renewed = bindings.renewOperation(binding.getBindingId(), binding.getOperationOwner(),
                    binding.getOperationGeneration(), Duration.ofSeconds(120));
            assertThat(renewed.getVersion()).isEqualTo(binding.getVersion() + stage);
            assertThat(renewed.getOperationOwner()).isEqualTo(binding.getOperationOwner());
            assertThat(renewed.getOperationGeneration()).isEqualTo(binding.getOperationGeneration());
            if (stage == 1) {
                store.saveArm(binding, registration, reservation, configuration, arm);
            } else if (stage == 2) {
                store.saveBound(binding, registration, reservation, store.inspect(binding.getBindingId()), podUid, "a".repeat(64), "opaque:1", bound);
            } else {
                store.savePublication(binding, registration, reservation, store.inspect(binding.getBindingId()), publication);
            }
            assertThat(store.inspect(binding.getBindingId()).version()).isEqualTo(stage);
            assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(renewed.getVersion());
        }
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
    }

    @ParameterizedTest
    @ValueSource(strings = {"operator", "replacement"})
    void replacementClaimCannotAdvanceTheOriginalAssociation(String owner) {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var expected = store.inspect(binding.getBindingId());
        bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
        var replacement = bindings.claimOperation(binding.getBindingId(), owner, Duration.ofSeconds(120));
        assertThat(replacement.getOperationGeneration()).isEqualTo(binding.getOperationGeneration() + 1);
        assertThatThrownBy(() -> store.saveBound(binding, registration, reservation, expected, podUid, "a".repeat(64), "opaque:1", bound))
                .hasMessageContaining("original CSI node source association");
        assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("ARMED");
        assertThat(store.inspect(binding.getBindingId()).bound()).isNull();
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(replacement.getVersion());
    }

    @Test
    void sameGrantNonRenewalMutationCannotAdvanceTheOriginalAssociation() {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var expected = store.inspect(binding.getBindingId());
        var modified = bindings.compareAndSet(binding, binding.withLastHealthAt(Instant.now(), Instant.now()));
        assertThat(modified).isNotNull();
        assertThat(modified.getOperationOwner()).isEqualTo(binding.getOperationOwner());
        assertThat(modified.getOperationGeneration()).isEqualTo(binding.getOperationGeneration());
        assertThatThrownBy(() -> store.saveBound(binding, registration, reservation, expected, podUid, "a".repeat(64), "opaque:1", bound))
                .hasMessageContaining("original CSI node source association");
        assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("ARMED");
        assertThat(store.inspect(binding.getBindingId()).bound()).isNull();
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(modified.getVersion());
    }

    @ParameterizedTest
    @ValueSource(strings = {"deadline", "operator", "replacement", "renewal"})
    void lateValidNodeRechecksTheOriginalAdmissionBeforeOpeningTheGate(String boundary) throws Exception {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var api = mock(KubernetesRuntimeClient.class);
        var node = configureNodeEvidencePeers(api);
        var source = mock(CsiNodeSourceClient.class);
        var gateway = mock(CsiNodeSourceClient.class);
        var nodeReply = new CompletableFuture<Map<String, Object>>();
        var nodeEntered = new CountDownLatch(1);
        var expired = new AtomicBoolean();
        var nodeReads = new AtomicInteger();
        when(api.getCluster("nodes", configuration.node().name())).thenAnswer(call -> {
            if (nodeReads.incrementAndGet() == 1) {
                return CompletableFuture.completedFuture(node);
            }
            nodeEntered.countDown();
            return nodeReply;
        });
        String armId = configuration.scope().armId();
        when(source.bind(eq(armId), eq(podUid), eq(registration.pvName()), anyString(), eq("opaque:1")))
                .thenAnswer(call -> {
                    bound = admittedBound(call.getArgument(3), call.getArgument(4));
                    return new CsiNodeSourceClient.Control(bound, bound.stream().head());
                });
        try (var evidence = new WorkspaceCsiNodeEvidence(store, configuration.node(), registration, api, source, gateway,
                "registry.example/worker@sha256:" + configuration.imageDigest());
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var spec = Map.<String, Object>of("runtimeClassName", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS,
                    "affinity", evidence.affinity(), "schedulingGates",
                    List.of(Map.of("name", KubernetesHttpRuntimeClient.CSI_SOURCE_GATE)));
            var metadata = Map.<String, Object>of("namespace", registration.namespace(), "name",
                    WorkspaceCsiRuntimeIdentity.name(binding.getProvisionSeed()), "uid", podUid, "resourceVersion", "opaque:1");
            var pod = Map.<String, Object>of("metadata", metadata, "spec", spec);
            var openedSpec = new LinkedHashMap<>(spec);
            openedSpec.remove("schedulingGates");
            when(api.releaseCsiSchedulingGate(registration.namespace(), configuration.scope().podName(), podUid, "opaque:1", spec))
                    .thenReturn(CompletableFuture.completedFuture(Map.of("metadata", metadata, "spec", openedSpec)));
            var result = executor.submit(() -> evidence.bindAndOpen(binding, reservation, pod, () -> {
                var current = bindings.findById(binding.getBindingId());
                WorkspaceCsiRuntimeIdentity.require(!expired.get()
                        && binding.getOperationOwner().equals(current.getOperationOwner())
                        && binding.getOperationGeneration() == current.getOperationGeneration());
            }));
            try {
                assertThat(nodeEntered.await(3, TimeUnit.SECONDS)).isTrue();
                assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("BOUND");
                if ("deadline".equals(boundary)) {
                    expired.set(true);
                } else if ("renewal".equals(boundary)) {
                    assertThat(bindings.renewOperation(binding.getBindingId(), binding.getOperationOwner(),
                            binding.getOperationGeneration(), Duration.ofSeconds(300))).isNotNull();
                } else {
                    bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
                    var replacement = bindings.claimOperation(binding.getBindingId(), boundary, Duration.ofSeconds(120));
                    assertThat(replacement.getOperationGeneration()).isEqualTo(binding.getOperationGeneration() + 1);
                }
                nodeReply.complete(node);
                if ("renewal".equals(boundary)) {
                    assertThat(result.get(3, TimeUnit.SECONDS).get("spec")).isEqualTo(openedSpec);
                    verify(api).releaseCsiSchedulingGate(registration.namespace(), configuration.scope().podName(), podUid, "opaque:1", spec);
                } else {
                    assertThatThrownBy(() -> result.get(3, TimeUnit.SECONDS)).hasCauseInstanceOf(RuntimeBrokerException.class);
                    verify(api, never()).releaseCsiSchedulingGate(any(), any(), any(), any(), any());
                }
                assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("BOUND");
                assertThat(store.inspect(binding.getBindingId()).bound().bytes()).isEqualTo(bound.bytes());
            } finally {
                nodeReply.completeExceptionally(new IllegalStateException("Owned test closed"));
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"deadline", "reclaim"})
    void originalProviderStopsAfterLateNodeWithProtocolSourceFixtures(String boundary) throws Exception {
        var api = mock(KubernetesRuntimeClient.class);
        var node = configureNodeEvidencePeers(api);
        var source = mock(CsiNodeSourceClient.class);
        var gateway = mock(CsiNodeSourceClient.class);
        var guard = mock(WorkspaceCsiResourceGuard.class);
        String uid = configuration.node().identity().nodeUid();
        var protection = new WorkspaceCsiResourceGuard.ProtectionIdentity(uid, "protect", uid, 1, "protect-binding", uid, 1);
        when(guard.verify()).thenReturn(CompletableFuture.completedFuture(new WorkspaceCsiResourceGuard.Receipt(
                registration.physicalKey(), registration.revision(), uid, "1", "1", protection)));
        when(source.observeEvidence()).thenReturn(initial);
        when(source.arm(configuration.scope(), configuration.imageDigest()))
                .thenReturn(new CsiNodeSourceClient.Control(arm, arm.stream().head()));
        when(source.bind(eq(configuration.scope().armId()), eq(podUid), eq(registration.pvName()), anyString(), eq("opaque:1")))
                .thenAnswer(call -> {
                    bound = admittedBound(call.getArgument(3), call.getArgument(4));
                    return new CsiNodeSourceClient.Control(bound, bound.stream().head());
                });
        var objects = new ConcurrentHashMap<String, Map<String, Object>>();
        when(api.get(any(), any(), any())).thenAnswer(call -> CompletableFuture.completedFuture(objects.get(call.getArgument(0))));
        when(api.create(any(), any(), any())).thenAnswer(call -> {
            String resource = call.getArgument(0);
            Map<String, Object> requested = call.getArgument(2);
            Map<String, Object> value = json.convertValue(requested, new com.fasterxml.jackson.core.type.TypeReference<>() { });
            WorkspaceCsiRuntimeIdentity.map(value.get("metadata")).putAll(Map.of("uid", podUid, "resourceVersion", "opaque:1"));
            objects.put(resource, value);
            return CompletableFuture.completedFuture(value);
        });
        var nodeReply = new CompletableFuture<Map<String, Object>>();
        var entered = new CountDownLatch(1);
        var closed = new CountDownLatch(1);
        var nodeReads = new AtomicInteger();
        when(api.getCluster("nodes", configuration.node().name())).thenAnswer(call -> {
            if (nodeReads.incrementAndGet() <= 2) {
                return CompletableFuture.completedFuture(node);
            }
            entered.countDown();
            return nodeReply;
        });
        var evidence = spy(new WorkspaceCsiNodeEvidence(store, configuration.node(), registration, api, source, gateway,
                "registry.example/worker@sha256:" + configuration.imageDigest()));
        doAnswer(call -> {
            try {
                return call.callRealMethod();
            }
            finally {
                closed.countDown();
            }
        }).when(evidence).bindAndOpen(any(), any(), any(), any());
        try (var provider = new WorkspaceCsiRuntimeProvisioner(new WorkspaceCsiReservationStore(jdbc, manager, json),
                bindings, registration, api, guard, "registry.example/worker@sha256:" + configuration.imageDigest(),
                List.of("node", "/opt/qwen/dist/cli.js"), Duration.ofSeconds(5), List.of(), "http://127.0.0.1:8701", evidence)) {
            provider.reserveResource(binding);
            var result = provider.ensureResource(binding.getRequest(), binding.getProvisionSeed(), null).toCompletableFuture();
            try {
                if (!entered.await(3, TimeUnit.SECONDS)) {
                    result.get(3, TimeUnit.SECONDS);
                    throw new AssertionError("The original provider never reached the owned Node pause");
                }
                assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("BOUND");
                if ("deadline".equals(boundary)) {
                    assertThatThrownBy(() -> result.get(7, TimeUnit.SECONDS)).hasCauseInstanceOf(RuntimeBrokerException.class);
                } else {
                    bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
                    var replacement = bindings.claimOperation(binding.getBindingId(), "replacement", Duration.ofSeconds(120));
                    assertThat(replacement.getOperationGeneration()).isEqualTo(binding.getOperationGeneration() + 1);
                }
                nodeReply.complete(node);
                assertThat(closed.await(3, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> result.get(1, TimeUnit.SECONDS)).hasCauseInstanceOf(RuntimeBrokerException.class);
                verify(api, never()).releaseCsiSchedulingGate(any(), any(), any(), any(), any());
                assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("BOUND");
                assertThat(bindings.findById(binding.getBindingId()).getResourceHandle()).isNull();
            } finally {
                nodeReply.completeExceptionally(new IllegalStateException("Owned provider test closed"));
            }
        }
    }

    @Test
    void holderRevisionDriftRollsBackTheOriginalAssociationTransition() {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var expected = store.inspect(binding.getBindingId());
        jdbc.update("UPDATE ma_storage_owner SET csi_revision = 4 WHERE storage_key = ?", registration.physicalKey());
        assertThatThrownBy(() -> store.saveBound(binding, registration, reservation, expected, podUid, "a".repeat(64), "opaque:1", bound))
                .hasMessageContaining("original CSI node source association");
        var actual = store.inspect(binding.getBindingId());
        assertThat(actual.phase()).isEqualTo("ARMED");
        assertThat(actual.version()).isEqualTo(1);
        assertThat(actual.podUid()).isNull();
        assertThat(actual.arm().bytes()).isEqualTo(arm.bytes());
        assertThat(jdbc.queryForObject("SELECT csi_revision FROM ma_storage_owner WHERE storage_key = ?", Long.class,
                registration.physicalKey())).isEqualTo(4);
    }

    @Test
    void refusesForeignArmBeforePersistenceAndRefusesAnAmbientTransaction() {
        var scope = configuration.scope();
        var foreign = new WorkspaceCsiNodeSourceStore.Configuration(configuration.node(), configuration.imageDigest(),
                new CsiNodeSourceJournal.Scope(scope.armId(), scope.namespace(), scope.podName(), "", "", scope.driver(),
                        scope.volumeId(), scope.pvUid(), scope.pvcUid(), "", "foreign-binding", ""));
        assertThatThrownBy(() -> store.saveArm(binding, registration, reservation, foreign, arm))
                .hasMessageContaining("original CSI node source association");
        assertThatThrownBy(() -> new TransactionTemplate(manager).executeWithoutResult(status ->
                store.saveArm(binding, registration, reservation, configuration, arm)))
                .hasMessageContaining("original CSI node source association");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_csi_source", Long.class)).isZero();
    }

    record Protocol(CsiNodeSourceJournal.Evidence initial, CsiNodeSourceJournal.Evidence arm,
            CsiNodeSourceJournal.Evidence bound, CsiNodeSourceJournal.Evidence publication,
            WorkspaceCsiNodeSourceStore.Configuration configuration) { }

    static Protocol protocol(RuntimeBindingRecord binding, WorkspaceCsiRegistration registration,
            WorkspaceCsiReservationStore.Reservation reservation) throws Exception {
        var json = new ObjectMapper();
        String podUid = "aa36d481-0995-4060-8ce7-f3d42c3e408f";
        byte[] raw;
        try (var input = WorkspaceCsiNodeSourceStoreTest.class.getResourceAsStream("/contracts/k2-node-source-v7.fixture.json")) {
            raw = Base64.getDecoder().decode(json.readTree(input).path("bytesBase64").textValue());
        }
        var input = ByteBuffer.wrap(raw);
        var frames = new ArrayList<ObjectNode>();
        var hashes = new HashMap<Long, String>();
        String previous = "0".repeat(64);
        while (input.hasRemaining() && frames.size() < 14) {
            byte[] frame = new byte[input.getInt()];
            input.get(frame);
            var record = (ObjectNode) json.readTree(frame);
            if (record.has("scope")) {
                var scope = (ObjectNode) record.path("scope");
                scope.put("armId", UUID.nameUUIDFromBytes(("qwen-csi-source-arm/1\0" + binding.getBindingId() + "\0"
                        + reservation.reservationId()).getBytes(StandardCharsets.UTF_8)).toString());
                scope.put("bindingId", binding.getBindingId());
                scope.put("namespace", registration.namespace());
                scope.put("podName", com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.name(binding.getProvisionSeed()));
                scope.put("driver", registration.driver());
                scope.put("volumeId", registration.volumeHandle());
                scope.put("pvUid", registration.pvUid());
                scope.put("pvcUid", registration.pvcUid());
                if (!scope.path("podUid").textValue().isEmpty()) {
                    scope.put("podUid", podUid);
                    scope.put("target", "/var/lib/kubelet/pods/" + podUid + "/volumes/kubernetes.io~csi/pv/mount");
                }
                if (record.has("runtime")) {
                    ((ObjectNode) record.path("runtime")).put("podUid", podUid).put("armId", scope.path("armId").textValue());
                }
            }
            WorkspaceCsiBirthTestInputs.mapOriginalScope(record, hashes);
            record.put("previous", previous);
            for (String field : new String[] {"begin", "publish", "stop"}) {
                if (record.has(field)) {
                    ((ObjectNode) record.path(field)).put("hash", hashes.get(record.path(field).path("sequence").longValue()));
                }
            }
            record.remove("hash");
            previous = CsiNativeActivationProof.sha256(json.writeValueAsBytes(record));
            record.put("hash", previous);
            hashes.put(record.path("sequence").longValue(), previous);
            frames.add(record);
        }
        var initial = prefix(frames, 1);
        var arm = prefix(frames, 2);
        var bound = prefix(frames, 3);
        var publication = prefix(frames, 14);
        var identity = arm.stream().source();
        var node = new WorkspaceCsiNodeSourceStore.Node("node", arm.stream().incarnation(), identity,
                URI.create("https://source.invalid"), "spiffe://test/source", URI.create("https://gateway.invalid"), "spiffe://test/gateway", arm.record(arm.stream().observations().getFirst().arm()).path("policy").path("rawSha256").textValue(), WorkspaceCsiBirthTestInputs.reviewed(), WorkspaceCsiInstalledByteTestInputs.reviewed());
        var observed = publication.stream().observations().getFirst();
        String imageDigest = publication.record(observed.custody()).path("runtime").path("imageDigest").textValue();
        return new Protocol(initial, arm, bound, publication,
                new WorkspaceCsiNodeSourceStore.Configuration(node, imageDigest, arm.stream().observations().getFirst().scope()));
    }

    private Map<String, Object> configureNodeEvidencePeers(KubernetesRuntimeClient api) {
        var node = Map.<String, Object>of("metadata", Map.of("name", configuration.node().name(), "uid", configuration.node().identity().nodeUid()),
                "status", Map.of("nodeInfo", Map.of("bootID", configuration.node().identity().bootId()),
                        "conditions", List.of(Map.of("type", "Ready", "status", "True"))));
        when(api.getCluster("nodes", configuration.node().name())).thenReturn(CompletableFuture.completedFuture(node));
        when(api.getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS)).thenReturn(CompletableFuture.completedFuture(Map.of(
                "apiVersion", "node.k8s.io/v1", "kind", "RuntimeClass", "handler", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS,
                "metadata", Map.of("name", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS, "uid", podUid))));
        return node;
    }

    @Test
    void sourceConfigurationPreservesUnsignedKernelIdentity() throws Exception {
        var before = configuration.node();
        var identity = before.identity();
        var maximum = new java.math.BigInteger("18446744073709551615");
        var unsigned = new CsiNodeSourceJournal.SourceIdentity(identity.nodeUid(), identity.bootId(), identity.runtimeDigest(),
                maximum, identity.runtimePid(), identity.gatewayIncarnation(), identity.pluginDigest(), maximum, identity.pluginPid(),
                identity.sourceArtifacts(), identity.gatewayArtifacts());
        var node = new WorkspaceCsiNodeSourceStore.Node(before.name(), before.incarnation(), unsigned, before.sourceOrigin(),
                before.sourcePrincipal(), before.gatewayOrigin(), before.gatewayPrincipal(), before.workerPolicySha256(), before.birthInputs(), before.installedBytes());
        var expected = new WorkspaceCsiNodeSourceStore.Configuration(node, configuration.imageDigest(), configuration.scope());
        var restored = WorkspaceCsiNodeSourceStore.decode(json.writeValueAsString(expected), WorkspaceCsiNodeSourceStore.Configuration.class);
        assertThat(restored).isEqualTo(expected);
        assertThat(restored.node().identity().runtimeStart()).isEqualTo(maximum);
        assertThat(restored.node().identity().pluginStart()).isEqualTo(maximum);
    }

    @Test
    void sourceConfigurationRejectsMissingNullFloatingAndStringIdentityNumbers() throws Exception {
        var encoded = (ObjectNode) json.readTree(json.writeValueAsString(configuration));
        for (String fault : java.util.List.of("missing", "null", "float", "string")) {
            var altered = encoded.deepCopy();
            var identity = (ObjectNode) altered.path("node").path("identity");
            switch (fault) {
                case "missing" -> identity.remove("runtimePid");
                case "null" -> identity.putNull("runtimePid");
                case "float" -> identity.put("runtimePid", 1.5);
                case "string" -> identity.put("runtimePid", "1");
                default -> throw new AssertionError(fault);
            }
            assertThatThrownBy(() -> WorkspaceCsiNodeSourceStore.decode(altered.toString(), WorkspaceCsiNodeSourceStore.Configuration.class))
                    .isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class)
                    .hasMessage("The original CSI node source association is unavailable.");
        }
        assertThat(WorkspaceCsiNodeSourceStore.decode(encoded.toString(), WorkspaceCsiNodeSourceStore.Configuration.class)).isEqualTo(configuration);
    }
    private CsiNodeSourceJournal.Evidence admittedBound(String specHash, String resourceVersion) throws Exception {
        var input = ByteBuffer.wrap(bound.bytes());
        var frames = new ArrayList<ObjectNode>();
        String previous = "0".repeat(64);
        while (input.hasRemaining()) {
            byte[] bytes = new byte[input.getInt()];
            input.get(bytes);
            var record = (ObjectNode) json.readTree(bytes);
            if ("BIND".equals(record.path("kind").textValue())) {
                record.put("gatedSpecSha256", specHash).put("podResourceVersion", resourceVersion);
            }
            record.put("previous", previous);
            record.remove("hash");
            previous = CsiNativeActivationProof.sha256(json.writeValueAsBytes(record));
            record.put("hash", previous);
            frames.add(record);
        }
        return prefix(frames, 3);
    }

    @ParameterizedTest
    @ValueSource(strings = {"spec", "rv"})
    void mismatchedAdmittedBindCannotPersistOrOpenTheGate(String changed) throws Exception {
        store.saveArm(binding, registration, reservation, configuration, arm);
        var api = mock(KubernetesRuntimeClient.class);
        configureNodeEvidencePeers(api);
        var source = mock(CsiNodeSourceClient.class);
        var gateway = mock(CsiNodeSourceClient.class);
        try (var evidence = new WorkspaceCsiNodeEvidence(store, configuration.node(), registration, api, source, gateway,
                "registry.example/worker@sha256:" + configuration.imageDigest())) {
            var spec = Map.<String, Object>of("runtimeClassName", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS,
                    "affinity", evidence.affinity(), "schedulingGates",
                    List.of(Map.of("name", KubernetesHttpRuntimeClient.CSI_SOURCE_GATE)));
            var supplied = admittedBound("spec".equals(changed) ? "f".repeat(64) : WorkspaceCsiRuntimeIdentity.digest(spec),
                    "rv".equals(changed) ? "opaque:wrong" : "opaque:1");
            when(source.bind(anyString(), anyString(), anyString(), anyString(), anyString()))
                    .thenReturn(new CsiNodeSourceClient.Control(supplied, supplied.stream().head()));
            var metadata = Map.<String, Object>of("namespace", registration.namespace(), "name", configuration.scope().podName(),
                    "uid", podUid, "resourceVersion", "opaque:1");
            assertThatThrownBy(() -> evidence.bindAndOpen(binding, reservation, Map.of("metadata", metadata, "spec", spec), () -> {}))
                    .isInstanceOf(RuntimeBrokerException.class);
            assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("ARMED");
            assertThat(store.inspect(binding.getBindingId()).bound()).isNull();
            verify(source).bind(anyString(), anyString(), anyString(), anyString(), anyString());
            verify(api, never()).releaseCsiSchedulingGate(any(), any(), any(), any(), any());
        }
    }

    @Test
    void wrongReviewedPolicyCannotSaveArm() {
        var old = configuration.node();
        assertThatThrownBy(() -> new WorkspaceCsiNodeSourceStore.Node(old.name(), old.incarnation(), old.identity(), old.sourceOrigin(),
                old.sourcePrincipal(), old.gatewayOrigin(), old.gatewayPrincipal(), "f".repeat(64), old.birthInputs(), old.installedBytes()))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(store.inspect(binding.getBindingId())).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"kubelet", "registrar"})
    void independentFrontendExpectationRefusesArmBeforeSqlMutation(String changed) {
        var node = configuration.node();
        var bytes = node.installedBytes();
        var reviewed = new WorkspaceCsiNodeSourceStore.InstalledBytes(bytes.source(), bytes.gateway(),
                changed.equals("kubelet") ? "f".repeat(64) : bytes.kubeletSha256(),
                changed.equals("registrar") ? "f".repeat(64) : bytes.registrarSha256());
        var selected = new WorkspaceCsiNodeSourceStore.Node(node.name(), node.incarnation(), node.identity(), node.sourceOrigin(),
                node.sourcePrincipal(), node.gatewayOrigin(), node.gatewayPrincipal(), node.workerPolicySha256(), node.birthInputs(), reviewed);
        var expected = new WorkspaceCsiNodeSourceStore.Configuration(selected, configuration.imageDigest(), configuration.scope());
        var holder = jdbc.queryForList("SELECT * FROM ma_storage_owner");
        var before = bindings.findById(binding.getBindingId());
        assertThatThrownBy(() -> store.saveArm(binding, registration, reservation, expected, arm))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(store.inspect(binding.getBindingId())).isNull();
        assertThat(jdbc.queryForList("SELECT * FROM ma_storage_owner")).usingRecursiveComparison().isEqualTo(holder);
        assertThat(bindings.findById(binding.getBindingId())).usingRecursiveComparison().isEqualTo(before);
    }

    @ParameterizedTest
    @ValueSource(strings = {"shim", "runc", "sandbox", "contract"})
    void publicationConsumesReviewedBirthInputsBeforeSqlMutation(String changed) throws Exception {
        var node = configuration.node();
        var inputs = node.birthInputs();
        String contract = inputs.creationContract();
        if (changed.equals("contract")) {
            var value = (ObjectNode) json.readTree(Base64.getDecoder().decode(contract));
            ((ObjectNode) value.path("worker")).putArray("args").add("/different-reviewed-command");
            contract = Base64.getEncoder().encodeToString(json.writeValueAsBytes(value));
        }
        var reviewed = new WorkspaceCsiNodeSourceStore.BirthInputs(changed.equals("shim") ? "f".repeat(64) : inputs.shimSha256(),
                changed.equals("runc") ? "f".repeat(64) : inputs.runcSha256(),
                changed.equals("sandbox") ? "f".repeat(64) : inputs.sandboxImageSha256(), contract);
        var selected = new WorkspaceCsiNodeSourceStore.Node(node.name(), node.incarnation(), node.identity(), node.sourceOrigin(),
                node.sourcePrincipal(), node.gatewayOrigin(), node.gatewayPrincipal(), node.workerPolicySha256(), reviewed, node.installedBytes());
        var expected = new WorkspaceCsiNodeSourceStore.Configuration(selected, configuration.imageDigest(), configuration.scope());
        store.saveArm(binding, registration, reservation, expected, arm);
        store.saveBound(binding, registration, reservation, store.inspect(binding.getBindingId()), podUid, "a".repeat(64), "opaque:1", bound);
        var before = store.inspect(binding.getBindingId());
        assertThatThrownBy(() -> store.savePublication(binding, registration, reservation, before, publication))
                .isInstanceOf(RuntimeBrokerException.class);
        var after = store.inspect(binding.getBindingId());
        assertThat(after.phase()).isEqualTo("BOUND");
        assertThat(after.version()).isEqualTo(2);
        assertThat(after.configuration()).isEqualTo(expected);
        assertThat(after.bound().bytes()).isEqualTo(before.bound().bytes());
        assertThat(after.publication()).isNull();
    }

    private static CsiNodeSourceJournal.Evidence prefix(ArrayList<ObjectNode> frames, int count) throws Exception {
        var json = new ObjectMapper();
        var bytes = new ByteArrayOutputStream();
        try (var output = new DataOutputStream(bytes)) {
            for (var frame : frames.subList(0, count)) {
                byte[] raw = json.writeValueAsBytes(frame);
                output.writeInt(raw.length);
                output.write(raw);
            }
        }
        var head = frames.get(count - 1);
        return CsiNodeSourceJournal.verify(bytes.toByteArray(),
                new CsiNodeSourceJournal.Cursor(head.path("sequence").longValue(), head.path("hash").textValue()));
    }
}
