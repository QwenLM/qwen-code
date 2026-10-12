package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.CannotCreateTransactionException;

class WorkspaceCsiRuntimeIdentityTest {
    private static final String IMAGE = "registry.example/worker@sha256:" + "a".repeat(64);
    private static final String UID = "11111111-1111-4111-8111-111111111111";
    private static final List<String> COMMAND = List.of("node", "/opt/qwen/dist/cli.js");
    private final WorkspaceCsiRegistration registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime",
            "claim", "pvc-uid", "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "serial", "/workspace", 1);
    private final WorkspaceCsiResourceGuard.ProtectionIdentity protection = new WorkspaceCsiResourceGuard.ProtectionIdentity(
            UID, "protect", UID, 1, "protect-binding", UID, 1);
    private DriverManagerDataSource source;
    private JdbcRuntimeBindingRepository bindings;
    private WorkspaceCsiReservationStore storage;
    private RuntimeBindingRecord original;
    private Api api;
    private RuntimeTransport transport;
    private final AtomicInteger attestations = new AtomicInteger();
    private Runnable afterAttestation = () -> { };

    @BeforeEach
    void setUp() {
        source = new DriverManagerDataSource("jdbc:h2:mem:provenance-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        storage = new WorkspaceCsiReservationStore(new JdbcTemplate(source), new DataSourceTransactionManager(source), new ObjectMapper());
        storage.register(registration);
        var request = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"), null, "kubernetes-workspace", "storage");
        var created = bindings.findOrCreate(request);
        original = bindings.claimOperation(created.getBindingId(), "owner", Duration.ofMinutes(5));
        api = new Api();
        transport = mock(RuntimeTransport.class);
        when(transport.attest(any(), any(), any())).thenAnswer(call -> {
            RuntimeProvisionRequest requested = call.getArgument(1);
            RuntimeProvisionSeed seed = call.getArgument(2);
            return CompletableFuture.completedFuture(new RuntimeAttestation(seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(),
                    seed.getLeaseId(), seed.getEpoch(), requested.getScope(), seed.getProvisionRequestId(), requested.getStorageId()));
        });
        when(transport.attestCsi(any(), any(), any(), any(), any())).thenAnswer(call -> {
            attestations.incrementAndGet();
            RuntimeProvisionRequest requested = call.getArgument(1);
            RuntimeProvisionSeed seed = call.getArgument(2);
            Map<String, Object> tuple = call.getArgument(3);
            Map<String, Object> pod = call.getArgument(4);
            var boot = ManagedCsiProtocol.boot(requested, seed, tuple);
            var response = Map.of("protocolVersion", 1, "managedCsi", ManagedCsiProtocol.PROTOCOL,
                    "context", WorkspaceCsiRuntimeIdentity.context(boot), "storage", tuple, "pod", pod,
                    "mount", Map.of("mountId", "9", "device", "259:1", "source", "/dev/nvme1n1", "diskSerial", "serial",
                            "rootDevice", "66305", "rootInode", "2"));
            afterAttestation.run();
            return CompletableFuture.completedFuture(response);
        });
    }

    @Test
    void freshApiIdentityPersistsReloadsAndRestoresOnlyOriginalObjects() {
        RuntimeResourceHandle handle;
        RuntimeLease lease;
        try (var provider = provider()) {
            provider.reserveResource(original);
            handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(api.creates).isEqualTo(2);
            assertThat(attestations).hasValue(2);
            original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
            lease = join(provider.provision(original.getRequest(), original.getProvisionSeed()));
            original = bindings.compareAndSet(original, original.withAttestation(lease, handle, Instant.now(), Instant.now()));
            WorkspaceCsiRuntimeIdentity.verify(original);
            assertThat(WorkspaceCsiRuntimeIdentity.expectedPod(original).get("uid")).isEqualTo(UID);
            assertThat(WorkspaceCsiRuntimeIdentity.boot(original).get("version")).isEqualTo(3);
            assertThat(new String(WorkspaceCsiRuntimeIdentity.bytes(handle.getValue()), StandardCharsets.UTF_8))
                    .doesNotContain(original.getProvisionSeed().getToken());
            var pod = api.objects.get("pods");
            assertThat(nested(pod, "spec").get("restartPolicy")).isEqualTo("Never");
            assertThat(nested(pod, "spec").get("automountServiceAccountToken")).isEqualTo(false);
            assertThat(nested(pod, "spec")).doesNotContainKeys("hostNetwork", "hostPID", "hostIPC");
            assertThat(new String(WorkspaceCsiRuntimeIdentity.bytes(pod), StandardCharsets.UTF_8)).contains("persistentVolumeClaim", "QWEN_POD_UID");
        }
        var reloaded = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])).findById(original.getBindingId());
        WorkspaceCsiRuntimeIdentity.verify(reloaded);
        try (var restarted = provider()) {
            assertThat(join(restarted.reconcile(reloaded.getRequest(), reloaded.getProvisionSeed(), reloaded.getResourceHandle(), lease)).getOutcome())
                    .isEqualTo(RuntimeObservation.Outcome.READY);
            join(restarted.confirm(reloaded.getRequest(), lease));
            join(restarted.release(reloaded.getRequest(), lease));
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void existingOrAmbiguousCreateNeverAdoptsOrCreatesAnotherPod() {
        for (String resource : List.of("secrets", "pods")) {
            api = new Api();
            api.objects.put(resource, Map.of("existing", true));
            try (var provider = provider()) {
                provider.reserveResource(original);
                refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                assertThat(api.creates).isZero();
            }
        }
        for (String resource : List.of("secrets", "pods")) {
            api = new Api();
            api.loseReply = resource;
            try (var provider = provider()) {
                provider.reserveResource(original);
                refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                int creates = api.creates;
                refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                assertThat(api.creates).isEqualTo(creates);
                assertThat(storage.inspect(registration).phase()).isEqualTo("RESERVED");
            }
        }
    }

    @Test
    void refusesReplacementAndContainerChangesEvenWhenRestartCountRemainsZero() {
        List<Consumer<Api>> changes = List.of(
                value -> nested(value.objects.get("pods"), "metadata").put("uid", UUID.randomUUID().toString()),
                value -> nested(value.objects.get("secrets"), "metadata").put("uid", UUID.randomUUID().toString()),
                value -> nested(value.objects.get("nodes"), "metadata").put("uid", UUID.randomUUID().toString()),
                value -> value.containerStatus().put("containerID", "containerd://" + "c".repeat(64)),
                value -> value.containerStatus().put("imageID", "sha256:" + "c".repeat(64)),
                value -> value.containerStatus().put("restartCount", 1),
                value -> nested(value.objects.get("pods"), "spec").put("hostNetwork", true),
                value -> nested(value.objects.get("pods"), "spec").remove("automountServiceAccountToken"),
                value -> nested(value.objects.get("pods"), "spec").put("nodeName", "different"),
                value -> nested(value.objects.get("pods"), "status").put("podIP", "10.4.0.9"),
                value -> nested(value.objects.get("secrets"), "data").put("boot.json", "e30="),
                value -> nested(value.objects.get("pods"), "spec").put("ephemeralContainers", List.of(Map.of("name", "debug"))),
                value -> nested(value.objects.get("validatingadmissionpolicies"), "metadata").put("generation", 2));
        for (var change : changes) {
            setUp();
            try (var provider = provider()) {
                provider.reserveResource(original);
                var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
                change.accept(api);
                assertThat(join(provider.reconcile(original.getRequest(), original.getProvisionSeed(), handle, null)).getOutcome())
                        .isEqualTo(RuntimeObservation.Outcome.CONFLICT);
                assertThat(api.creates).isEqualTo(2);
            }
        }
    }

    @Test
    void storageObservationOutagesStayUnknownAndRecoverWithoutReplacingThePod() {
        for (RuntimeException outage : List.of(
                new DataAccessResourceFailureException("temporary SQL outage"),
                new CannotCreateTransactionException("temporary connection outage"))) {
            setUp();
            storage = spy(storage);
            try (var provider = provider()) {
                provider.reserveResource(original);
                var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
                var lease = join(provider.provision(original.getRequest(), original.getProvisionSeed()));
                var reservation = storage.inspect(registration);
                doThrow(outage).when(storage).inspect(registration);
                for (int retry = 0; retry < 2; retry++) {
                    assertThat(join(provider.reconcile(original.getRequest(), original.getProvisionSeed(), handle, lease)).getOutcome())
                            .isEqualTo(RuntimeObservation.Outcome.UNKNOWN);
                    assertThat(provider.isUsable(lease)).isFalse();
                }
                doCallRealMethod().when(storage).inspect(registration);
                assertThat(storage.inspect(registration)).isEqualTo(reservation);
                assertThat(join(provider.reconcile(original.getRequest(), original.getProvisionSeed(), handle, lease)).getOutcome())
                        .isEqualTo(RuntimeObservation.Outcome.READY);
                join(provider.confirm(original.getRequest(), lease));
                assertThat(api.creates).isEqualTo(2);
                assertThat(bindings.findById(original.getBindingId()).getVersion()).isEqualTo(original.getVersion());
            }
        }
    }

    @Test
    void foreignFailuresCannotRevokeTheOriginalPlacementButItsOwnFailureDoes() {
        try (var provider = provider()) {
            provider.reserveResource(original);
            var request = original.getRequest();
            var seed = original.getProvisionSeed();
            var handle = join(provider.ensureResource(request, seed, null));
            original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
            var lease = join(provider.provision(request, seed));
            assertThat(provider.isUsable(lease)).isTrue();
            refused(provider.provision(request, RuntimeProvisionSeed.create("another-binding", 1)));
            assertThat(provider.isUsable(lease)).isTrue();
            var forged = new RuntimeResourceHandle(handle.getKind(), handle.getVersion(), Map.of("forged", true));
            assertThat(join(provider.reconcile(request, seed, forged, lease)).getOutcome())
                    .isEqualTo(RuntimeObservation.Outcome.CONFLICT);
            refused(provider.ensureResource(request, seed, forged));
            assertThat(provider.isUsable(lease)).isTrue();
            var wrongRequest = new RuntimeProvisionRequest(request.getScope(), null, "kubernetes-workspace", "other-storage");
            refused(provider.confirm(wrongRequest, lease));
            assertThat(provider.isUsable(lease)).isTrue();
            join(provider.confirm(request, lease));
            api.objects.remove("pods");
            refused(provider.confirm(request, lease));
            assertThat(provider.isUsable(lease)).isFalse();
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void failedFinalAdmissionRevokesOnlyTheFreshPlacementItCreated() {
        bindings = spy(bindings);
        doAnswer(call -> {
            if (attestations.get() >= 2) {
                throw new DataAccessResourceFailureException("final admission unavailable");
            }
            return call.callRealMethod();
        }).when(bindings).findById(any());
        try (var provider = provider()) {
            provider.reserveResource(original);
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            var lease = WorkspaceCsiRuntimeIdentity.lease(original.getProvisionSeed(), Map.of("podIp", "10.4.0.8"));
            assertThat(attestations).hasValue(2);
            assertThat(provider.isUsable(lease)).isFalse();
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void changesDuringAttestationAndFailedProtectionCannotReturnAHandle() {
        afterAttestation = () -> api.containerStatus().put("containerID", "containerd://" + "c".repeat(64));
        try (var provider = provider()) {
            provider.reserveResource(original);
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(api.creates).isEqualTo(2);
        }
        api = new Api();
        nested(api.objects.get("persistentvolumeclaims"), "metadata").put("uid", "foreign");
        try (var provider = provider()) {
            provider.reserveResource(original);
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(api.creates).isZero();
        }
    }

    @Test
    void retirementDuringAttestationKeepsTheHolderAndCannotReturnTheLateHandle() {
        afterAttestation = () -> storage.beginRetirement(registration, bindings, original,
                storage.inspect(registration), UUID.randomUUID().toString());
        try (var provider = provider()) {
            provider.reserveResource(original);
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            var sealed = bindings.findById(original.getBindingId());
            assertThat(sealed.getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
            assertThat(sealed.getResourceHandle()).isNull();
            assertThat(storage.inspect(registration).phase()).isEqualTo("DRAINING");
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void suppliedButUnpersistedHandleCannotAuthorizeReadonlyAdoption() {
        try (var provider = provider()) {
            provider.reserveResource(original);
            var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            try (var restarted = provider()) {
                assertThat(join(restarted.reconcile(original.getRequest(), original.getProvisionSeed(), handle, null)).getOutcome())
                        .isEqualTo(RuntimeObservation.Outcome.CONFLICT);
                refused(restarted.ensureResource(original.getRequest(), original.getProvisionSeed(), handle));
                assertThat(api.creates).isEqualTo(2);
            }
        }
    }

    @Test
    void pendingPodReadinessSurvivesRenewalBetweenAdmissionReads() {
        var pendingReads = new AtomicInteger();
        var renewals = new AtomicInteger();
        api.changeCreatedPod = pod -> WorkspaceCsiRuntimeIdentity.map(
                ((List<?>) nested(pod, "status").get("containerStatuses")).getFirst()).put("ready", false);
        api.observePod = pod -> {
            if (pendingReads.incrementAndGet() >= 3) {
                api.containerStatus().put("ready", true);
            }
        };
        bindings = spy(bindings);
        doAnswer(call -> {
            RuntimeBindingRecord snapshot = (RuntimeBindingRecord) call.callRealMethod();
            if (pendingReads.get() > 0) {
                var renewed = bindings.renewOperation(snapshot.getBindingId(), snapshot.getOperationOwner(),
                        snapshot.getOperationGeneration(), Duration.ofMinutes(5));
                assertThat(renewed).isNotNull();
                assertThat(renewed.getVersion()).isGreaterThan(snapshot.getVersion());
                renewals.incrementAndGet();
            }
            return snapshot;
        }).when(bindings).findById(any());
        try (var provider = provider()) {
            provider.reserveResource(original);
            var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(pendingReads).hasValueGreaterThanOrEqualTo(3);
            assertThat(renewals).hasValueGreaterThanOrEqualTo(2);
            assertThat(handle.getKind()).isEqualTo("kubernetes-workspace");
            assertThat(storage.inspect(registration).phase()).isEqualTo("RESERVED");
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void expiredClaimAndNoAdmissionCauseZeroCreates() {
        try (var provider = provider()) {
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            provider.reserveResource(original);
            new JdbcTemplate(source).update("UPDATE qwen_runtime_binding SET operation_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(api.creates).isZero();
        }
    }

    @Test
    void newPodRejectsUnsafeDefaultsWhileAcceptingOmittedCoreFalseBooleans() {
        for (var change : List.<Consumer<Map<String, Object>>>of(
                pod -> {
                    var container = WorkspaceCsiRuntimeIdentity.map(((List<?>) nested(pod, "spec").get("containers")).getFirst());
                    nested(container, "securityContext").put("runAsUser", 0);
                },
                pod -> {
                    var container = WorkspaceCsiRuntimeIdentity.map(((List<?>) nested(pod, "spec").get("containers")).getFirst());
                    nested(container, "securityContext").put("runAsNonRoot", false);
                },
                pod -> nested(pod, "spec").put("hostUsers", false),
                pod -> nested(pod, "spec").put("hostAliases", List.of(Map.of("ip", "127.0.0.1", "hostnames", List.of("override")))),
                pod -> nested(nested(pod, "spec"), "securityContext").put("sysctls", List.of(Map.of("name", "kernel.shm_rmid_forced", "value", "0"))),
                pod -> nested(pod, "spec").put("hostPID", true),
                pod -> nested(pod, "spec").remove("automountServiceAccountToken"),
                pod -> {
                    var volumes = (List<?>) nested(pod, "spec").get("volumes");
                    var pvc = WorkspaceCsiRuntimeIdentity.map(volumes.get(1));
                    nested(pvc, "persistentVolumeClaim").put("readOnly", true);
                })) {
            api = new Api();
            api.changeCreatedPod = change;
            try (var provider = provider()) {
                provider.reserveResource(original);
                refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
                assertThat(attestations).hasValue(0);
                assertThat(api.creates).isEqualTo(2);
            }
        }
    }

    @Test
    void optionalApiDefaultsDoNotBecomeRequiredPodFields() {
        api.changeCreatedPod = pod -> {
            var spec = nested(pod, "spec");
            spec.putAll(Map.of("hostNetwork", false, "hostPID", false, "hostIPC", false,
                    "dnsPolicy", "ClusterFirst", "schedulerName", "default-scheduler", "terminationGracePeriodSeconds", 30));
            var container = WorkspaceCsiRuntimeIdentity.map(((List<?>) spec.get("containers")).getFirst());
            container.putAll(Map.of("terminationMessagePath", "/dev/termination-log", "terminationMessagePolicy", "File"));
        };
        try (var provider = provider()) {
            provider.reserveResource(original);
            var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(handle).isNotNull();
            assertThat(attestations).hasValue(2);
        }
    }

    @ParameterizedTest
    @CsvSource({"true,false", "false,true", "true,true"})
    void acceptsBuiltinServiceAccountAndPriorityAdmissionFields(boolean pullSecrets, boolean priorityClass) {
        var fields = new LinkedHashMap<String, Object>();
        if (pullSecrets) {
            fields.put("imagePullSecrets", List.of(Map.of("name", "registry-pull-secret")));
        }
        if (priorityClass) {
            fields.put("priorityClassName", "default-priority");
        }
        api.changeCreatedPod = pod -> nested(pod, "spec").putAll(fields);
        RuntimeResourceHandle handle;
        RuntimeLease lease;
        try (var provider = provider()) {
            provider.reserveResource(original);
            handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(nested(api.objects.get("pods"), "spec")).containsAllEntriesOf(fields);
            assertThat(attestations).hasValue(2);
            original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
            lease = join(provider.provision(original.getRequest(), original.getProvisionSeed()));
            original = bindings.compareAndSet(original, original.withAttestation(lease, handle, Instant.now(), Instant.now()));
        }
        var reloaded = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]))
                .findById(original.getBindingId());
        try (var restarted = provider()) {
            assertThat(join(restarted.ensureResource(reloaded.getRequest(), reloaded.getProvisionSeed(), reloaded.getResourceHandle())))
                    .isEqualTo(handle);
            assertThat(join(restarted.reconcile(reloaded.getRequest(), reloaded.getProvisionSeed(), reloaded.getResourceHandle(), lease)).getOutcome())
                    .isEqualTo(RuntimeObservation.Outcome.READY);
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void timedOutSecretReplyCannotStartPodAfterTheDeadline() {
        api.secretReply = new CompletableFuture<>();
        try (var provider = provider(Duration.ofMillis(300), List.of())) {
            provider.reserveResource(original);
            refused(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            api.secretReply.complete(api.objects.get("secrets"));
            assertThat(api.creates).isEqualTo(1);
            assertThat(api.objects).doesNotContainKey("pods");
        }
    }

    @Test
    void immutableArtifactBytesAndUidArePinnedAndRevalidated() throws Exception {
        byte[] chunk = "compressed-test-input".getBytes(StandardCharsets.UTF_8);
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(chunk));
        api.objects.put("configmaps", copy(Map.of("apiVersion", "v1", "kind", "ConfigMap", "immutable", true,
                "metadata", Map.of("name", "worker-000", "namespace", "runtime", "uid", UID),
                "binaryData", Map.of("chunk", Base64.getEncoder().encodeToString(chunk)))));
        try (var provider = provider(Duration.ofSeconds(5), List.of(new WorkspaceCsiRuntimeProvisioner.WorkerArtifact("worker-000", UID, sha)))) {
            provider.reserveResource(original);
            var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            assertThat(new String(WorkspaceCsiRuntimeIdentity.bytes(api.objects.get("pods")), StandardCharsets.UTF_8))
                    .contains("/var/run/qwen-worker-parts", "000");
            original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
            nested(api.objects.get("configmaps"), "binaryData").put("chunk", "Y2hhbmdlZA==");
            assertThat(join(provider.reconcile(original.getRequest(), original.getProvisionSeed(), handle, null)).getOutcome())
                    .isEqualTo(RuntimeObservation.Outcome.CONFLICT);
            assertThat(api.creates).isEqualTo(2);
        }
    }

    @Test
    void publicIdentityReaderRejectsNullLegacyAndChangedSeedBoundPins() {
        assertThatThrownBy(() -> WorkspaceCsiRuntimeIdentity.verify(original)).isInstanceOf(RuntimeBrokerException.class);
        try (var provider = provider()) {
            provider.reserveResource(original);
            var handle = join(provider.ensureResource(original.getRequest(), original.getProvisionSeed(), null));
            original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now()));
            var lease = join(provider.provision(original.getRequest(), original.getProvisionSeed()));
            var ready = original.withAttestation(lease, handle, Instant.now(), Instant.now());
            for (var invalid : List.of(new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", UID)),
                    new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("podUid", UID)))) {
                assertThatThrownBy(() -> WorkspaceCsiRuntimeIdentity.verify(ready.withResourceHandle(invalid, Instant.now())))
                        .isInstanceOf(RuntimeBrokerException.class);
            }
            var changed = new LinkedHashMap<>(handle.getValue());
            changed.put("bootDigest", "f".repeat(64));
            assertThatThrownBy(() -> WorkspaceCsiRuntimeIdentity.verify(ready.withResourceHandle(
                    new RuntimeResourceHandle("kubernetes-workspace", 1, changed), Instant.now()))).isInstanceOf(RuntimeBrokerException.class);
        }
    }

    private WorkspaceCsiRuntimeProvisioner provider() {
        return provider(Duration.ofSeconds(5), List.of());
    }

    private WorkspaceCsiRuntimeProvisioner provider(Duration timeout, List<WorkspaceCsiRuntimeProvisioner.WorkerArtifact> artifacts) {
        return new WorkspaceCsiRuntimeProvisioner(storage, bindings, registration, api,
                new WorkspaceCsiResourceGuard(api, "cluster", registration, protection), IMAGE, COMMAND, timeout, artifacts, transport);
    }

    private final class Api implements KubernetesRuntimeClient {
        private final Map<String, Map<String, Object>> objects = new LinkedHashMap<>();
        private int creates;
        private String loseReply;
        private Consumer<Map<String, Object>> changeCreatedPod = ignored -> { };
        private Consumer<Map<String, Object>> observePod = ignored -> { };
        private CompletableFuture<Map<String, Object>> secretReply;

        private Api() {
            objects.put("persistentvolumeclaims", object("PersistentVolumeClaim", "claim", "runtime", "pvc-uid",
                    Map.of("volumeName", "volume", "volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod")), Map.of("phase", "Bound")));
            objects.put("persistentvolumes", object("PersistentVolume", "volume", null, "pv-uid",
                    Map.of("volumeMode", "Filesystem", "accessModes", List.of("ReadWriteOncePod"),
                            "claimRef", Map.of("apiVersion", "v1", "kind", "PersistentVolumeClaim", "name", "claim", "namespace", "runtime", "uid", "pvc-uid"),
                            "csi", Map.of("driver", registration.driver(), "volumeHandle", "handle", "fsType", "ext4")), Map.of("phase", "Bound")));
            var namespace = object("Namespace", "runtime", null, UID, Map.of(), Map.of("phase", "Active"));
            nested(namespace, "metadata").put("labels", Map.of("pod-security.kubernetes.io/enforce", "restricted", "pod-security.kubernetes.io/enforce-version", "v1.36"));
            objects.put("namespaces", namespace);
            var policy = copy(WorkspaceCsiResourceGuard.policy(registration, "protect"));
            nested(policy, "metadata").putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "1"));
            policy.put("status", Map.of("observedGeneration", 1, "typeChecking", Map.of()));
            objects.put("validatingadmissionpolicies", policy);
            var binding = copy(WorkspaceCsiResourceGuard.binding("protect", "protect-binding"));
            nested(binding, "metadata").putAll(Map.of("uid", UID, "generation", 1, "resourceVersion", "1"));
            objects.put("validatingadmissionpolicybindings", binding);
            objects.put("nodes", object("Node", "node", null, UID, Map.of(), Map.of("conditions", List.of(Map.of("type", "Ready", "status", "True")))));
        }

        @Override
        public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
            if (resource.equals("pods") && objects.get(resource) != null) {
                observePod.accept(objects.get(resource));
            }
            return CompletableFuture.completedFuture(objects.get(resource));
        }

        @Override
        public CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
            return CompletableFuture.completedFuture(objects.get(resource));
        }

        @Override
        public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body) {
            creates++;
            var value = copy(body);
            nested(value, "metadata").put("uid", UID);
            if (resource.equals("pods")) {
                nested(value, "spec").put("nodeName", "node");
                value.put("status", copy(Map.of("phase", "Running", "podIP", "10.4.0.8", "containerStatuses", List.of(Map.of(
                        "name", "runtime", "restartCount", 0, "ready", true, "state", Map.of("running", Map.of("startedAt", "2026-10-03T00:00:00Z")),
                        "containerID", "containerd://" + "b".repeat(64), "imageID", "sha256:" + "d".repeat(64))))));
            }
            if (resource.equals("pods")) {
                changeCreatedPod.accept(value);
            }
            objects.put(resource, value);
            if (resource.equals(loseReply)) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(503, "lost", "lost", true));
            }
            if (resource.equals("secrets") && secretReply != null) {
                return secretReply;
            }
            return CompletableFuture.completedFuture(value);
        }

        private Map<String, Object> containerStatus() {
            return WorkspaceCsiRuntimeIdentity.map(((List<?>) nested(objects.get("pods"), "status").get("containerStatuses")).getFirst());
        }
    }

    private static Map<String, Object> object(String kind, String name, String namespace, String uid, Map<String, Object> spec, Map<String, Object> status) {
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", name, "uid", uid, "resourceVersion", "1"));
        if (namespace != null) {
            metadata.put("namespace", namespace);
        }
        return copy(Map.of("apiVersion", "v1", "kind", kind, "metadata", metadata, "spec", spec, "status", status));
    }

    private static Map<String, Object> copy(Map<String, Object> value) {
        return new ObjectMapper().convertValue(value, new TypeReference<>() { });
    }

    private static Map<String, Object> nested(Map<String, Object> value, String field) {
        return WorkspaceCsiRuntimeIdentity.map(value.get(field));
    }

    private static <T> T join(CompletionStage<T> result) {
        return result.toCompletableFuture().join();
    }

    private static void refused(CompletionStage<?> result) {
        assertThatThrownBy(() -> join(result)).hasCauseInstanceOf(RuntimeBrokerException.class);
    }
}
