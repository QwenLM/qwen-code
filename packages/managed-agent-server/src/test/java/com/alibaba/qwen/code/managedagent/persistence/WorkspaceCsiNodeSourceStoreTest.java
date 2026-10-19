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
import com.alibaba.qwen.code.runtimebroker.provisioning.CsiPodDeletion;
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
    private CsiNodeSourceJournal.Evidence stopIntent;
    private CsiNodeSourceJournal.Evidence stopped;
    private CsiNodeSourceJournal.Evidence unpublished;
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
        stopIntent = protocol.stopIntent();
        stopped = protocol.stopped();
        unpublished = protocol.unpublished();
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

    @Test
    void physicalSourceUsesEveryOriginalPublicationCursorWithoutChangingTheAssociation() {
        store.saveArm(binding, registration, reservation, configuration, arm);
        store.saveBound(binding, registration, reservation, store.inspect(binding.getBindingId()), podUid, "a".repeat(64), "opaque:1", bound);
        store.savePublication(binding, registration, reservation, store.inspect(binding.getBindingId()), publication);
        var original = store.inspect(binding.getBindingId());
        String retirement = stopIntent.stream().observations().getFirst().scope().retirementId();
        String planHash = stopIntent.record(stopIntent.stream().observations().getFirst().intent()).path("intentHash").textValue();
        for (var evidence : List.of(stopIntent, stopped, unpublished)) {
            var result = WorkspaceCsiPhysicalSource.validate(original, retirement, planHash, evidence);
            assertThat(result.state()).isEqualTo(evidence.stream().observations().getFirst().state());
            assertThat(result.publish()).isEqualTo(publication.stream().observations().getFirst().publish());
            assertThat(result.custody()).isEqualTo(publication.stream().observations().getFirst().custody());
        }
        assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("PUBLISHED");
        assertThat(store.inspect(binding.getBindingId()).version()).isEqualTo(3);
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
    }

    @ParameterizedTest
    @ValueSource(strings = {"retirement", "plan", "publication", "foreign-binding"})
    void physicalSourceRefusesWrongOriginalLineage(String boundary) {
        store.saveArm(binding, registration, reservation, configuration, arm);
        store.saveBound(binding, registration, reservation, store.inspect(binding.getBindingId()), podUid, "a".repeat(64), "opaque:1", bound);
        store.savePublication(binding, registration, reservation, store.inspect(binding.getBindingId()), publication);
        var original = store.inspect(binding.getBindingId());
        String retirement = unpublished.stream().observations().getFirst().scope().retirementId();
        String planHash = unpublished.record(unpublished.stream().observations().getFirst().intent()).path("intentHash").textValue();
        if ("foreign-binding".equals(boundary)) {
            original = new WorkspaceCsiNodeSourceStore.Association("foreign", original.generation(), original.physicalKey(),
                    original.reservationId(), original.reservationRevision(), original.configuration(), original.phase(), original.version(),
                    original.arm(), original.podUid(), original.gatedSpecSha256(), original.bound(), original.publication());
        }
        var selected = original;
        String selectedRetirement = "retirement".equals(boundary) ? UUID.randomUUID().toString() : retirement;
        String selectedHash = "plan".equals(boundary) ? "0".repeat(64) : planHash;
        var evidence = "publication".equals(boundary) ? publication : unpublished;
        assertThatThrownBy(() -> WorkspaceCsiPhysicalSource.validate(selected, selectedRetirement, selectedHash, evidence))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(store.inspect(binding.getBindingId()).phase()).isEqualTo("PUBLISHED");
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
    }

    record Protocol(CsiNodeSourceJournal.Evidence initial, CsiNodeSourceJournal.Evidence arm,
            CsiNodeSourceJournal.Evidence bound, CsiNodeSourceJournal.Evidence publication,
            WorkspaceCsiNodeSourceStore.Configuration configuration, CsiNodeSourceJournal.Evidence stopIntent,
            CsiNodeSourceJournal.Evidence stopped, CsiNodeSourceJournal.Evidence unpublished) { }

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
        while (input.hasRemaining()) {
            byte[] frame = new byte[input.getInt()];
            input.get(frame);
            var record = (ObjectNode) json.readTree(frame);
            if ("SOURCE_START".equals(record.path("kind").textValue())) {
                ((ObjectNode) record.path("source")).put("nodeUid", "92d3bdd2-ac4c-4564-9dca-976be8f06979");
            }
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
                if (!scope.path("retirementId").textValue().isEmpty()) {
                    scope.put("retirementId", "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08");
                }
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
        var stopIntent = prefix(frames, 15);
        var stopped = prefix(frames, 16);
        var unpublished = prefix(frames, 18);
        var identity = arm.stream().source();
        var node = new WorkspaceCsiNodeSourceStore.Node("node", arm.stream().incarnation(), identity,
                URI.create("https://source.invalid"), "spiffe://test/source", URI.create("https://gateway.invalid"), "spiffe://test/gateway", arm.record(arm.stream().observations().getFirst().arm()).path("policy").path("rawSha256").textValue(), WorkspaceCsiBirthTestInputs.reviewed(), WorkspaceCsiInstalledByteTestInputs.reviewed());
        var observed = publication.stream().observations().getFirst();
        String imageDigest = publication.record(observed.custody()).path("runtime").path("imageDigest").textValue();
        var configuration = new WorkspaceCsiNodeSourceStore.Configuration(node, imageDigest, arm.stream().observations().getFirst().scope());
        return new Protocol(initial, arm, bound, publication, configuration, stopIntent, stopped, unpublished);
    }

    @Test
    void physicalCoordinatorPersistsPlanBeforeRequestingIntent() throws Exception {
        var original = publishedAssociation();
        var physical = mock(WorkspaceCsiPhysicalStore.class);
        var source = mock(CsiNodeSourceClient.class);
        var api = mock(KubernetesRuntimeClient.class);
        var guard = mock(WorkspaceCsiResourceGuard.class);
        byte[] plan = coordinatorPlan();
        var state = new WorkspaceCsiPhysicalStore.Status("d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", "PLANNED", 1, CsiNativeActivationProof.sha256(plan), 0);
        var selected = new WorkspaceCsiPhysicalStore.Original("tenant", binding.getRequest().getIsolationKey(), "workspace", state.retirementId());
        when(physical.plan(selected, "token", configuration.node())).thenReturn(new WorkspaceCsiPhysicalStore.Work(state, original, plan, null));
        var evidence = physicalEvidence(plan, 15);
        when(source.requestStop(configuration.scope().armId(), state.retirementId(), state.planSha256()))
                .thenAnswer(invocation -> {
                    assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                    return new CsiNodeSourceClient.Control(evidence, evidence.stream().head());
                });
        var saved = new WorkspaceCsiPhysicalStore.Status(state.retirementId(), "INTENT", 2, state.planSha256(), 0);
        when(physical.saveIntent(selected, "token", evidence)).thenReturn(saved);
        configureCoordinatorPeers(api, guard);
        var coordinator = new WorkspaceCsiPhysicalCoordinator(physical, configuration.node(), source, api, guard);
        assertThat(coordinator.intent(selected, "token")).isEqualTo(saved);
        var ordered = org.mockito.Mockito.inOrder(physical, guard, api, source);
        ordered.verify(physical).plan(selected, "token", configuration.node());
        ordered.verify(guard).verify();
        ordered.verify(api).getCluster("nodes", configuration.node().name());
        ordered.verify(source).requestStop(configuration.scope().armId(), state.retirementId(), state.planSha256());
        ordered.verify(physical).saveIntent(selected, "token", evidence);
        verify(api, never()).deleteCsiPod(any());
    }

    @ParameterizedTest
    @ValueSource(strings = {"accepted", "lost", "pending", "replacement"})
    void physicalCoordinatorSavesRequestBeforeSendAndCannotInventALostReply(String window) throws Exception {
        var original = publishedAssociation();
        var physical = mock(WorkspaceCsiPhysicalStore.class);
        var source = mock(CsiNodeSourceClient.class);
        var api = mock(KubernetesRuntimeClient.class);
        var guard = mock(WorkspaceCsiResourceGuard.class);
        byte[] plan = coordinatorPlan();
        var evidence = physicalEvidence(plan, 15);
        var state = new WorkspaceCsiPhysicalStore.Status("d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", "INTENT", 2, CsiNativeActivationProof.sha256(plan), 0);
        var selected = new WorkspaceCsiPhysicalStore.Original("tenant", binding.getRequest().getIsolationKey(), "workspace", state.retirementId());
        when(physical.plan(selected, "token", configuration.node())).thenReturn(new WorkspaceCsiPhysicalStore.Work(state, original, plan, evidence));
        when(source.observeEvidence()).thenReturn(evidence);
        configureCoordinatorPeers(api, guard);
        var spec = Map.of("restartPolicy", "Never", "nodeName", configuration.node().name());
        when(api.get("pods", registration.namespace(), configuration.scope().podName())).thenReturn(CompletableFuture.completedFuture(
                Map.of("apiVersion", "v1", "kind", "Pod", "metadata", Map.of("name", configuration.scope().podName(),
                        "namespace", registration.namespace(), "uid", window.equals("replacement") ? UUID.randomUUID().toString() : podUid,
                        "resourceVersion", "opaque:315"), "spec", spec)));
        var prepared = new AtomicBoolean();
        var request = CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "opaque:315");
        var pending = new WorkspaceCsiPhysicalStore.Status(state.retirementId(), "INTENT", 3, state.planSha256(), 1);
        when(physical.prepareDeletion(org.mockito.ArgumentMatchers.eq(selected), org.mockito.ArgumentMatchers.eq("token"), any()))
                .thenAnswer(invocation -> {
                    var actual = invocation.getArgument(2, CsiPodDeletion.Request.class);
                    assertThat(actual.bytes()).isEqualTo(request.bytes());
                    prepared.set(true);
                    return new WorkspaceCsiPhysicalStore.Attempt(pending, 1, request, !window.equals("pending"));
                });
        var reply = mock(CsiPodDeletion.Result.class);
        when(reply.request()).thenReturn(request);
        when(reply.statusCode()).thenReturn(202);
        when(reply.responseBytes()).thenReturn(new byte[0]);
        when(api.deleteCsiPod(request)).thenAnswer(invocation -> {
            assertThat(prepared.get()).isTrue();
            assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return window.equals("lost") ? CompletableFuture.failedFuture(new java.io.IOException("explicit lost-reply fixture"))
                    : CompletableFuture.completedFuture(reply);
        });
        var saved = new WorkspaceCsiPhysicalStore.Status(state.retirementId(), "INTENT", 4, state.planSha256(), 1);
        when(physical.saveReply(selected, "token", 1, reply)).thenReturn(saved);
        var coordinator = new WorkspaceCsiPhysicalCoordinator(physical, configuration.node(), source, api, guard);
        if (window.equals("lost") || window.equals("replacement")) {
            assertThatThrownBy(() -> coordinator.delete(selected, "token")).isInstanceOf(RuntimeException.class);
        } else {
            assertThat(coordinator.delete(selected, "token")).isEqualTo(window.equals("pending") ? pending : saved);
        }
        if (window.equals("replacement")) {
            verify(physical, never()).prepareDeletion(any(), any(), any());
        }
        if (window.equals("pending") || window.equals("replacement")) {
            verify(api, never()).deleteCsiPod(any());
        }
        if (!window.equals("accepted")) {
            verify(physical, never()).saveReply(any(), any(), org.mockito.ArgumentMatchers.anyInt(), any());
        } else {
            var ordered = org.mockito.Mockito.inOrder(physical, api);
            ordered.verify(physical).plan(selected, "token", configuration.node());
            ordered.verify(api).getCluster("nodes", configuration.node().name());
            ordered.verify(api).get("pods", registration.namespace(), configuration.scope().podName());
            ordered.verify(physical).prepareDeletion(org.mockito.ArgumentMatchers.eq(selected), org.mockito.ArgumentMatchers.eq("token"), any());
            ordered.verify(api).getCluster("nodes", configuration.node().name());
            ordered.verify(api).deleteCsiPod(request);
            ordered.verify(physical).saveReply(selected, "token", 1, reply);
        }
        assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("RESERVED");
    }

    private byte[] coordinatorPlan() throws Exception {
        var plan = (ObjectNode) json.readTree(physicalPlan());
        plan.put("registrationRevision", Long.toString(registration.revision()));
        plan.put("podSpecDigest", WorkspaceCsiRuntimeIdentity.digest(Map.of("restartPolicy", "Never", "nodeName", configuration.node().name())));
        plan.set("protection", json.valueToTree(Map.of("namespaceUid", podUid, "policyName", "protect", "policyUid", podUid,
                "policyGeneration", "1", "bindingName", "protect-binding", "bindingUid", podUid, "bindingGeneration", "1")));
        return json.writeValueAsBytes(plan);
    }

    private void configureCoordinatorPeers(KubernetesRuntimeClient api, WorkspaceCsiResourceGuard guard) {
        var protection = new WorkspaceCsiResourceGuard.ProtectionIdentity(podUid, "protect", podUid, 1, "protect-binding", podUid, 1);
        when(guard.verify()).thenReturn(CompletableFuture.completedFuture(new WorkspaceCsiResourceGuard.Receipt(
                registration.physicalKey(), registration.revision(), podUid, "pvc-rv", "pv-rv", protection)));
        when(api.getCluster("nodes", configuration.node().name())).thenReturn(CompletableFuture.completedFuture(Map.of(
                "apiVersion", "v1", "kind", "Node", "metadata", Map.of("name", configuration.node().name(), "uid", configuration.node().identity().nodeUid()),
                "status", Map.of("nodeInfo", Map.of("bootID", configuration.node().identity().bootId()),
                        "conditions", List.of(Map.of("type", "Ready", "status", "True"))))));
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
    void physicalProgressCanDeleteAnExistingPodAfterObservedStop() throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var stoppedEvidence = physicalEvidence(plan, 16);
        var current = WorkspaceCsiPhysicalProgress.planned(plan).withIntent(stoppedEvidence, original)
                .withObservation(stoppedEvidence, original);
        assertThat(current.stage()).isEqualTo("STOPPED");
        current = current.withAttempt(CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "315"));
        assertThat(current.stage()).isEqualTo("STOPPED");
        assertThat(current.attempts()).isEqualTo(1);
        assertThat(WorkspaceCsiPhysicalProgress.restore(current.version(), current.bytes(), current.sha256(),
                WorkspaceCsiApplicationJson.object(plan, 64 * 1024), original).bytes()).isEqualTo(current.bytes());
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
    void physicalPlanPreservesUnsignedSourceConfigurationWithoutSignedOrFloatingPointConversion() throws Exception {
        var original = publishedAssociation();
        var before = configuration.node();
        var identity = before.identity();
        var max = new java.math.BigInteger("18446744073709551615");
        var unsigned = new CsiNodeSourceJournal.SourceIdentity(identity.nodeUid(), identity.bootId(), identity.runtimeDigest(),
                max, identity.runtimePid(), identity.gatewayIncarnation(), identity.pluginDigest(), max, identity.pluginPid(), identity.sourceArtifacts(), identity.gatewayArtifacts());
        var node = new WorkspaceCsiNodeSourceStore.Node(before.name(), before.incarnation(), unsigned, before.sourceOrigin(),
                before.sourcePrincipal(), before.gatewayOrigin(), before.gatewayPrincipal(), before.workerPolicySha256(), before.birthInputs(), before.installedBytes());
        var encoded = new WorkspaceCsiNodeSourceStore.Configuration(node, configuration.imageDigest(), configuration.scope());
        byte[] configBytes = WorkspaceCsiApplicationJson.encode(encoded);
        var plan = (ObjectNode) json.readTree(physicalPlan());
        plan.put("sourceConfigurationBase64", Base64.getEncoder().encodeToString(configBytes));
        byte[] planBytes = json.writeValueAsBytes(plan);
        var current = WorkspaceCsiPhysicalProgress.planned(planBytes);
        var restored = WorkspaceCsiPhysicalProgress.restore(1, current.bytes(), current.sha256(),
                WorkspaceCsiApplicationJson.object(planBytes, 64 * 1024), original);
        byte[] saved = Base64.getDecoder().decode(json.readTree(restored.planBytes()).path("sourceConfigurationBase64").textValue());
        assertThat(saved).isEqualTo(configBytes);
        var decoded = WorkspaceCsiNodeSourceStore.decode(new String(saved, StandardCharsets.UTF_8), WorkspaceCsiNodeSourceStore.Configuration.class);
        assertThat(decoded.node().identity().runtimeStart()).isEqualTo(max);
        assertThat(decoded.node().identity().pluginStart()).isEqualTo(max);
        assertThat(store.inspect(binding.getBindingId()).configuration()).isEqualTo(configuration);
    }

    @Test
    void sourceConfigurationRejectsMissingNullFloatingAndStringIdentityNumbers() throws Exception {
        publishedAssociation();
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

    @ParameterizedTest
    @org.junit.jupiter.params.provider.CsvSource({"200", "202", "404", "409", "302", "500"})
    void observedApiReplyNeverAdvancesThePhysicalStage(int code) throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var request = CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "315");
        var current = WorkspaceCsiPhysicalProgress.planned(plan).withIntent(physicalEvidence(plan), original).withAttempt(request);
        var reply = mock(CsiPodDeletion.Result.class);
        when(reply.request()).thenReturn(request);
        when(reply.statusCode()).thenReturn(code);
        when(reply.responseBytes()).thenReturn(new byte[0]);
        var next = current.withReply(1, reply);
        assertThat(next.stage()).isEqualTo("INTENT");
        assertThat(WorkspaceCsiPhysicalProgress.restore(next.version(), next.bytes(), next.sha256(),
                WorkspaceCsiApplicationJson.object(plan, 64 * 1024), original).stage()).isEqualTo("INTENT");
        assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("RESERVED");
    }

    @Test
    void physicalProgressRetainsOriginalPlanUnknownRequestsAndObservedReplies() throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var expectedPlan = WorkspaceCsiApplicationJson.object(plan, 64 * 1024);
        var evidence = physicalEvidence(plan);
        var current = WorkspaceCsiPhysicalProgress.planned(plan);
        current = current.withIntent(evidence, original);
        assertThat(current.stage()).isEqualTo("INTENT");
        assertThat(current.version()).isEqualTo(2);
        assertThat(current.latestEvidence().stream().head().sequence()).isEqualTo(15);
        var request = CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "opaque:315");
        current = current.withAttempt(request);
        byte[] unknown = current.bytes();
        assertThat(current.withAttempt(request)).isSameAs(current);
        current = current.withAttempt(CsiPodDeletion.prepare(request.namespace(), request.name(), request.uid(), "opaque:316"));
        var second = WorkspaceCsiApplicationJson.object(current.bytes(), WorkspaceCsiPhysicalProgress.LIMIT);
        assertThat(second.path("attempts").get(0).path("statusCode").isNull()).isTrue();
        assertThat(current.attempt(1).bytes()).isEqualTo(request.bytes());
        assertThat(current.attempts()).isEqualTo(2);
        var result = mock(CsiPodDeletion.Result.class);
        when(result.request()).thenReturn(request);
        when(result.statusCode()).thenReturn(409);
        byte[] raw = "{\"kind\":\"Status\",\"reason\":\"Conflict\"}".getBytes(StandardCharsets.UTF_8);
        when(result.responseBytes()).thenReturn(raw);
        current = current.withReply(1, result);
        assertThat(current.withReply(1, result)).isSameAs(current);
        assertThat(current.stage()).isEqualTo("INTENT");
        var restored = WorkspaceCsiPhysicalProgress.restore(current.version(), current.bytes(), current.sha256(), expectedPlan, original);
        assertThat(restored.bytes()).isEqualTo(current.bytes());
        assertThat(restored.planBytes()).isEqualTo(plan);
        assertThat(restored.attempt(1).bytes()).isEqualTo(request.bytes());
        assertThat(WorkspaceCsiApplicationJson.object(restored.bytes(), WorkspaceCsiPhysicalProgress.LIMIT)
                .path("attempts").get(1).path("statusCode").isNull()).isTrue();
        restored = restored.withObservation(evidence, original);
        assertThat(restored.stage()).isEqualTo("UNPUBLISHED");
        assertThat(restored.version()).isEqualTo(6);
        assertThat(WorkspaceCsiPhysicalProgress.restore(restored.version(), restored.bytes(), restored.sha256(), expectedPlan, original).bytes())
                .isEqualTo(restored.bytes());
        assertThat(WorkspaceCsiPhysicalProgress.restore(3, unknown, CsiNativeActivationProof.sha256(unknown), expectedPlan, original).stage())
                .isEqualTo("INTENT");
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
        assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("RESERVED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_csi_physical", Integer.class)).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"extra", "version", "stage", "request", "ordinal", "reply", "trailing"})
    void physicalProgressRefusesChangedOrAmbiguousSavedImage(String fault) throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var current = WorkspaceCsiPhysicalProgress.planned(plan).withIntent(physicalEvidence(plan), original)
                .withAttempt(CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "315"));
        var altered = (ObjectNode) json.readTree(current.bytes());
        long version = current.version();
        switch (fault) {
            case "extra" -> altered.put("qualified", true);
            case "version" -> version++;
            case "stage" -> altered.put("stage", "RELEASED");
            case "request" -> ((ObjectNode) altered.path("attempts").get(0)).put("resourceVersion", "316");
            case "ordinal" -> ((ObjectNode) altered.path("attempts").get(0)).put("ordinal", 2);
            case "reply" -> ((ObjectNode) altered.path("attempts").get(0)).put("responseBase64", "");
            case "trailing" -> { /* Trailing bytes are appended after encoding. */ }
            default -> throw new AssertionError(fault);
        }
        byte[] bytes = fault.equals("trailing") ? (json.writeValueAsString(altered) + " {}").getBytes(StandardCharsets.UTF_8)
                : json.writeValueAsBytes(altered);
        long savedVersion = version;
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(savedVersion, bytes, CsiNativeActivationProof.sha256(bytes),
                WorkspaceCsiApplicationJson.object(plan, 64 * 1024), original)).isInstanceOf(IllegalArgumentException.class);
        assertThat(store.inspect(binding.getBindingId()).publication().bytes()).isEqualTo(publication.bytes());
    }

    @Test
    void physicalProgressBoundsAttemptsAndNeverResendsAnUnknownResourceVersion() throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var current = WorkspaceCsiPhysicalProgress.planned(plan).withIntent(physicalEvidence(plan), original);
        for (int index = 1; index <= 8; index++) {
            current = current.withAttempt(CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, Integer.toString(index)));
        }
        var full = current;
        assertThat(full.withAttempt(full.attempt(1))).isSameAs(full);
        assertThatThrownBy(() -> full.withAttempt(CsiPodDeletion.prepare(registration.namespace(), configuration.scope().podName(), podUid, "9")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(full.attempts()).isEqualTo(8);
        assertThat(WorkspaceCsiPhysicalProgress.restore(full.version(), full.bytes(), full.sha256(),
                WorkspaceCsiApplicationJson.object(plan, 64 * 1024), original).bytes()).isEqualTo(full.bytes());
    }

    @Test
    void physicalPlanReplayPinsEveryFieldAndNeverUpgradesAnOldPlan() throws Exception {
        var original = publishedAssociation();
        byte[] plan = physicalPlan();
        var expected = WorkspaceCsiApplicationJson.object(plan, 64 * 1024);
        var saved = WorkspaceCsiPhysicalProgress.planned(plan);
        assertThat(WorkspaceCsiPhysicalProgress.restore(saved.version(), saved.bytes(), saved.sha256(), expected, original).bytes())
                .isEqualTo(saved.bytes());
        var changed = ((ObjectNode) expected).deepCopy();
        changed.put("drainedInventorySha256", "b".repeat(64));
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(saved.version(), saved.bytes(), saved.sha256(), changed, original))
                .isInstanceOf(IllegalArgumentException.class);
        var changedHistory = ((ObjectNode) expected).deepCopy();
        changedHistory.put("sourceRowSha256", "c".repeat(64));
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(saved.version(), saved.bytes(), saved.sha256(), changedHistory, original))
                .isInstanceOf(IllegalArgumentException.class);
        var oldPlan = ((ObjectNode) expected).deepCopy();
        oldPlan.put("format", "qwen-csi-physical-plan/1");
        oldPlan.remove("drainedInventorySha256");
        oldPlan.remove("sourceRowSha256");
        var old = WorkspaceCsiPhysicalProgress.planned(WorkspaceCsiApplicationJson.encode(oldPlan));
        byte[] retained = old.bytes();
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(old.version(), old.bytes(), old.sha256(), expected, original))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(old.bytes()).isEqualTo(retained);
        assertThat(old.version()).isEqualTo(1);
        var previousPlan = ((ObjectNode) expected).deepCopy();
        previousPlan.put("format", "qwen-csi-physical-plan/2");
        previousPlan.remove("sourceRowSha256");
        var previous = WorkspaceCsiPhysicalProgress.planned(WorkspaceCsiApplicationJson.encode(previousPlan));
        var previousBytes = previous.bytes();
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(previous.version(), previous.bytes(), previous.sha256(), expected, original))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(previous.bytes()).isEqualTo(previousBytes);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_csi_physical", Integer.class)).isZero();
    }

    @Test
    void physicalPlanRefusesChangedBytesEvenWhenTheJsonValuesMatch() {
        byte[] plan = physicalPlan();
        var expected = WorkspaceCsiApplicationJson.object(plan, 64 * 1024);
        var canonical = WorkspaceCsiPhysicalProgress.planned(plan);
        assertThat(WorkspaceCsiPhysicalProgress.restore(1, canonical.bytes(), canonical.sha256(), expected, null).bytes())
                .isEqualTo(canonical.bytes());
        byte[] padded = (new String(plan, StandardCharsets.UTF_8) + "\n").getBytes(StandardCharsets.UTF_8);
        assertThat(WorkspaceCsiApplicationJson.object(padded, 64 * 1024)).isEqualTo(expected);
        var changed = WorkspaceCsiPhysicalProgress.planned(padded);
        assertThat(changed.planSha256()).isNotEqualTo(canonical.planSha256());
        assertThatThrownBy(() -> WorkspaceCsiPhysicalProgress.restore(1, changed.bytes(), changed.sha256(), expected, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void companionCatalogueRefusesAnyEarlyOrForeignPhysicalRowAndSchemaDrift() {
        new TransactionTemplate(manager).executeWithoutResult(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
            WorkspaceCsiPhysicalStore.requireEmpty(connection, "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", binding.getBindingId(), registration.physicalKey());
            return null;
        }));
        jdbc.update("INSERT INTO ma_csi_physical VALUES (?,?,?,?,?,?)", "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08",
                "foreign-binding", registration.physicalKey(), 1, new byte[] {1}, "a".repeat(64));
        assertThatThrownBy(() -> new TransactionTemplate(manager).executeWithoutResult(status -> jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                    WorkspaceCsiPhysicalStore.requireEmpty(connection, "other", binding.getBindingId(), registration.physicalKey());
                    return null;
                }))).isInstanceOf(IllegalArgumentException.class);
        jdbc.update("DELETE FROM ma_csi_physical");
        jdbc.execute("ALTER TABLE ma_csi_physical ADD COLUMN undeclared BIGINT");
        assertThatThrownBy(() -> new TransactionTemplate(manager).executeWithoutResult(status -> jdbc.execute(
                (org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                    WorkspaceCsiPhysicalStore.requireEmpty(connection, "other", binding.getBindingId(), registration.physicalKey());
                    return null;
                }))).isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForObject("SELECT csi_phase FROM ma_storage_owner", String.class)).isEqualTo("RESERVED");
    }

    private WorkspaceCsiNodeSourceStore.Association publishedAssociation() {
        store.saveArm(binding, registration, reservation, configuration, arm);
        store.saveBound(binding, registration, reservation, store.inspect(binding.getBindingId()), podUid, "a".repeat(64), "opaque:1", bound);
        store.savePublication(binding, registration, reservation, store.inspect(binding.getBindingId()), publication);
        return store.inspect(binding.getBindingId());
    }

    private byte[] physicalPlan() {
        return WorkspaceCsiApplicationJson.encode(Map.of("format", "qwen-csi-physical-coordination-plan/1", "drainedInventorySha256", "a".repeat(64),
                "sourceRowSha256", "d".repeat(64),
                "retirementId", "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", "bindingId", binding.getBindingId(),
                "physicalKey", registration.physicalKey(), "namespace", registration.namespace(),
                "podName", configuration.scope().podName(), "podUid", podUid));
    }

    private CsiNodeSourceJournal.Evidence physicalEvidence(byte[] plan) throws Exception {
        return physicalEvidence(plan, 18);
    }

    private CsiNodeSourceJournal.Evidence physicalEvidence(byte[] plan, int count) throws Exception {
        return physicalEvidence(unpublished, "d672a3e1-c0bf-4aca-9c28-16e9bed5ef08", plan, count);
    }

    static CsiNodeSourceJournal.Evidence physicalEvidence(CsiNodeSourceJournal.Evidence unpublished,
            String retirement, byte[] plan, int count) throws Exception {
        var json = new ObjectMapper();
        var input = ByteBuffer.wrap(unpublished.bytes());
        var frames = new ArrayList<ObjectNode>();
        var hashes = new HashMap<Long, String>();
        String previous = "0".repeat(64);
        while (input.hasRemaining()) {
            byte[] bytes = new byte[input.getInt()];
            input.get(bytes);
            var record = (ObjectNode) json.readTree(bytes);
            if (record.has("scope") && !record.path("scope").path("retirementId").textValue().isEmpty()) {
                ((ObjectNode) record.path("scope")).put("retirementId", retirement);
            }
            if (record.has("intentHash")) {
                record.put("intentHash", CsiNativeActivationProof.sha256(plan));
            }
            WorkspaceCsiBirthTestInputs.mapOriginalScope(record, hashes);
            record.put("previous", previous);
            for (String field : List.of("begin", "publish", "stop")) {
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
        return prefix(frames, count);
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
