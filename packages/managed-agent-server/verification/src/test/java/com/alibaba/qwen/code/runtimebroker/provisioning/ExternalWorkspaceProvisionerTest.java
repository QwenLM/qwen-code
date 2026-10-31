package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Component test for the {@code external-workspace} provisioning prerequisite
 * (#15512 step 3a).
 *
 * <p>Contract: a worker is placed only on a <em>persisted, tenant-bound</em>
 * registration; the Broker mints the shipped {@code managed-context/1} boot plus
 * the already-admitted {@code storage} member; identity, handle and recovery stay
 * bound to that registration; every disagreement fails closed with a permanent
 * code. The saved-binding drain primitive does not advertise blanket close
 * support or admit Hosted Sessions.
 */
class ExternalWorkspaceProvisionerTest {
    private static final String TENANT = "tenant-a";
    private static final String ALIAS = "workspace-a";
    private static final String PROVIDER = "provider-a";
    private static final String PHYSICAL = "physical-a";
    private static final String ALIAS_PATH = "/external/workspace-a";
    private static final String MOUNT = "/workspace/storage";
    private static final String CAPABILITY = WorkspaceExecutionProfile.CAPABILITY_DIGEST;

    private final RecordingClient client = new RecordingClient();
    private ExternalWorkspaceProvisioner provisioner;

    @AfterEach
    void close() {
        if (provisioner != null) {
            provisioner.close();
        }
    }

    private ExternalWorkspaceProvisioner provisioner(
            ExternalStorageRegistry.RegisteredExternalStorage registration) {
        ExternalStorageRegistry registry = (tenant, alias) -> Optional.ofNullable(registration);
        provisioner = new ExternalWorkspaceProvisioner(client, registry, PROVIDER, Duration.ofSeconds(5));
        return provisioner;
    }

    private static ExternalStorageRegistry.RegisteredExternalStorage registration(
            String provider, long revision, String mountRoot) {
        return new ExternalStorageRegistry.RegisteredExternalStorage(provider, PHYSICAL,
                revision, ALIAS, ALIAS_PATH, mountRoot);
    }

    private static RuntimeScope scope(String capability) {
        return new RuntimeScope(TENANT, ALIAS, "1", MOUNT, capability, "session");
    }

    private static RuntimeProvisionRequest request() {
        return new RuntimeProvisionRequest(scope(CAPABILITY), "isolation-a",
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, ALIAS);
    }

    private static RuntimeProvisionSeed seed(String name) {
        return new RuntimeProvisionSeed(name, "runtime-a", "incarnation-a",
                "lease-" + name, 1, "token-" + name);
    }

    private static <T> T join(CompletionStage<T> stage) throws Exception {
        return stage.toCompletableFuture().get(20, TimeUnit.SECONDS);
    }

    private static RuntimeBrokerException failure(CompletionStage<?> stage) {
        ExecutionException failure = org.junit.jupiter.api.Assertions.assertThrows(
                ExecutionException.class, () -> stage.toCompletableFuture().get(20, TimeUnit.SECONDS));
        assertTrue(failure.getCause() instanceof RuntimeBrokerException, String.valueOf(failure.getCause()));
        return (RuntimeBrokerException) failure.getCause();
    }

    /** Places the worker for one test and returns its handle and lease. */
    private Placement place(ExternalWorkspaceProvisioner subject, String name) throws Exception {
        RuntimeProvisionRequest request = request();
        RuntimeProvisionSeed seed = seed(name);
        RuntimeResourceHandle handle = join(subject.ensureResource(request, seed, null));
        client.provisionResponse = Map.of("protocolVersion", 1,
                "handle", handle.getValue().get("provider"), "endpoint", RecordingClient.ENDPOINT);
        client.observeState = "RUNNING";
        RuntimeLease lease = join(subject.provision(request, seed));
        return new Placement(request, seed, handle, lease);
    }

    private record Placement(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lease) {
    }

    @Test
    void aScopeWithoutTheWorkspaceDigestKeepsTheScratchShapedRequest() {
        // Delegating keeps the base request shape for non-Workspace scopes; the
        // profile then fails closed instead of inventing a storage binding.
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        for (String capability : List.of("sha256:" + "c".repeat(64),
                ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST,
                ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST)) {
            RuntimeProvisionRequest plain = subject.createRequest(scope(capability), "isolation-a");
            assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, plain.getProvisionerKind());
            assertFalse(plain.isManagedContext(), capability);
            RuntimeBrokerException refused = failure(
                    subject.ensureResource(plain, seed("plain-scope"), null));
            assertEquals("external_workspace_storage_required", refused.getCode());
            assertFalse(refused.isRetryable());
        }
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void registryReadFailuresStayRetryable() {
        provisioner = new ExternalWorkspaceProvisioner(client, (tenant, alias) -> {
            throw new IllegalStateException("database is down");
        }, PROVIDER, Duration.ofSeconds(5));
        RuntimeBrokerException refused = failure(provisioner.ensureResource(request(), seed("down"), null));
        assertEquals("runtime_external_unavailable", refused.getCode());
        assertTrue(refused.isRetryable(), "an unreadable registry must not bury the placement");
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void theSelectedAliasMakesTheRequestManagedContext() {
        RuntimeProvisionRequest request = provisioner(null).createRequest(scope(CAPABILITY), "isolation-a");
        assertEquals(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, request.getProvisionerKind());
        assertTrue(request.isManagedContext());
        assertEquals(ALIAS, request.getStorageId());
    }

    @Test
    void aRequestWithoutAStorageBindingIsRefused() {
        // A harness-Session caller that resolved no storage must not have a
        // storage-bound placement invented for it.
        RuntimeProvisionRequest plain = new RuntimeProvisionRequest(scope(CAPABILITY),
                "isolation-a", com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE);
        RuntimeBrokerException refused = failure(
                provisioner(registration(PROVIDER, 1, MOUNT)).ensureResource(plain, seed("plain"), null));
        assertEquals("external_workspace_storage_required", refused.getCode());
        assertFalse(refused.isRetryable());
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void aMissingRegistrationFailsClosedWithoutCallingTheProvider() {
        ExternalStorageRegistry empty = (tenant, alias) -> Optional.empty();
        provisioner = new ExternalWorkspaceProvisioner(client, empty, PROVIDER, Duration.ofSeconds(5));
        RuntimeBrokerException refused = failure(provisioner.ensureResource(request(), seed("missing"), null));
        assertEquals("external_storage_registration_not_found", refused.getCode());
        assertFalse(refused.isRetryable());
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void aRegistrationForAnotherProviderIsRefused() {
        RuntimeBrokerException refused = failure(provisioner(
                registration("provider-other", 1, MOUNT)).ensureResource(request(), seed("provider"), null));
        assertEquals("external_storage_registration_mismatch", refused.getCode());
        assertFalse(refused.isRetryable());
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void aRegistrationForAnotherMountRootIsRefused() {
        RuntimeBrokerException refused = failure(provisioner(
                registration(PROVIDER, 1, "/workspace/other")).ensureResource(request(), seed("mount"), null));
        assertEquals("external_storage_registration_mismatch", refused.getCode());
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void aCapabilityDigestTheWorkerRefusesIsRefusedHere() {
        String notWorkspace = "sha256:" + "b".repeat(64);
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope(notWorkspace),
                "isolation-a", com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE, ALIAS);
        RuntimeBrokerException refused = failure(
                provisioner(registration(PROVIDER, 1, MOUNT)).ensureResource(request, seed("cap"), null));
        assertEquals("external_storage_registration_mismatch", refused.getCode());
        assertTrue(client.provisions.isEmpty());
    }

    @Test
    void provisionMintsTheShippedBootWithTheRegisteredStorage() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 3, MOUNT));
        Placement placement = place(subject, "boot");

        Map<String, Object> boot = client.boot();
        assertEquals(17, boot.size(), "managed-context/1 plus the shipped storage member");
        assertEquals("boot", boot.get("type"));
        assertEquals(2, ((Number) boot.get("version")).intValue());
        assertEquals("managed-context/1", boot.get("managedContext"));
        assertEquals(ALIAS, boot.get("storageId"));
        assertEquals("session", boot.get("isolationClass"));
        assertEquals(CAPABILITY, boot.get("capabilityDigest"));
        assertEquals(MOUNT, boot.get("mountRoot"));
        assertEquals(placement.seed().getToken(), boot.get("token"));
        assertEquals(Map.of("kind", "external", "physicalKey", PHYSICAL,
                "aliasPath", ALIAS_PATH, "mountRoot", MOUNT,
                "registrationRevision", 3L), boot.get("storage"));
        // The worker's own admission predicate, mirrored: the context mount root
        // equals the storage mount root under session isolation.
        @SuppressWarnings("unchecked")
        Map<String, Object> storage = (Map<String, Object>) boot.get("storage");
        assertEquals(boot.get("mountRoot"), storage.get("mountRoot"));

        Map<String, Object> provisionBody = client.provisions.get(0);
        assertEquals(1, ((Number) provisionBody.get("protocolVersion")).intValue());
        assertEquals(placement.seed().getProvisionRequestId(), provisionBody.get("provisionRequestId"));
        assertEquals(placement.handle().getValue().get("provider"), provisionBody.get("handle"));
        assertTrue(provisionBody.get("scope") instanceof Map<?, ?>);
        String identity = String.valueOf(provisionBody.get("identity"));
        assertFalse(identity.contains(placement.seed().getToken()), "identity is token-free");
        assertFalse(identity.contains(PHYSICAL), "identity is a digest, not the physical key");
        assertEquals(RecordingClient.ENDPOINT + "/", placement.lease().getEndpoint().toString());
    }

    @Test
    void revisionDriftMakesTheOriginalHandleUnadoptable() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "drift");
        assertTrue(subject.supportsStartupRecovery(placement.handle()));

        // A fresh provisioner must reject a handle minted from a different identity.
        subject.close();
        subject = provisioner(registration(PROVIDER, 2, MOUNT));
        RuntimeObservation observed = join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease()));
        assertEquals(RuntimeObservation.Outcome.CONFLICT, observed.getOutcome());
    }

    @Test
    void observeWithoutStorageEvidenceKeepsPhaseOneParity() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "parity");
        assertEquals(RuntimeObservation.Outcome.READY, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
    }

    @Test
    void confirmingContinuityIsAdopted() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "confirms");
        client.storage = evidence("confirms", 1);
        assertEquals(RuntimeObservation.Outcome.READY, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
    }

    @Test
    void indeterminateContinuityKeepsOwnershipButNeverReadiness() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "unknown");
        client.storage = evidence("unknown", 1);
        assertEquals(RuntimeObservation.Outcome.UNKNOWN, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
        assertTrue(subject.isUsable(placement.lease()));
    }

    @Test
    void unknownStorageContinuityCannotOverrideAGoneWorker() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "gone-storage");
        client.observeState = "GONE";
        client.storage = evidence("unknown", 1);
        assertEquals(RuntimeObservation.Outcome.CONFLICT, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
        assertFalse(subject.isUsable(placement.lease()));
        assertEquals(1, client.provisions.size());
    }

    @Test
    void deniedContinuityIsAPermanentRefusal() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        RuntimeProvisionRequest request = request();
        RuntimeProvisionSeed seed = seed("denies");
        RuntimeResourceHandle handle = join(subject.ensureResource(request, seed, null));
        client.provisionResponse = Map.of("protocolVersion", 1,
                "handle", handle.getValue().get("provider"), "endpoint", RecordingClient.ENDPOINT);
        client.observeState = "RUNNING";
        client.storage = evidence("denies", 1);
        RuntimeBrokerException refused = failure(subject.provision(request, seed));
        assertEquals("external_storage_continuity_denied", refused.getCode());
        assertFalse(refused.isRetryable());
    }

    @Test
    void evidenceForAnotherStorageIdentityIsNeverBelieved() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "foreign");
        client.storage = evidence("confirms", 2);
        assertEquals(RuntimeObservation.Outcome.CONFLICT, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
    }

    @Test
    void aMountNonceThisProfileCannotVerifyIsRefused() throws Exception {
        // The design's wider evidence set names mountNonce; the persisted
        // registration cannot carry one yet, so accepting the member would mean
        // ignoring an unverified claim. It is refused until S2 persists it.
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "nonce");
        client.storage = Map.of("storageRef",
                ExternalWorkspaceProvisioner.storageRef(registration(PROVIDER, 1, MOUNT)),
                "mountRoot", MOUNT, "continuity", "confirms",
                "mountNonce", "nonce-a");
        assertEquals(RuntimeObservation.Outcome.CONFLICT, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
    }

    @Test
    void theStorageRefIsTheDocumentedIdentityTuple() {
        // Pinned fixture: canonical JSON of exactly {providerId, physicalKey,
        // registrationRevision} (sorted members, integer revision), SHA-256 hex.
        assertEquals("bc02fecc13c3be69643517ab58a55a200fe0ca71b9006a09947c9cc203f9ab79",
                ExternalWorkspaceProvisioner.storageRef(registration(PROVIDER, 1, MOUNT)));
        assertEquals("272884b45c2b7bdca79a3be07ad2f6c079b1bc6eb058701fb10e3348c8a17b35",
                ExternalWorkspaceProvisioner.storageRef(registration(PROVIDER, 3, MOUNT)));
    }

    @Test
    void malformedStorageEvidenceIsAPermanentRefusal() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "malformed");
        String storageRef = "bc02fecc13c3be69643517ab58a55a200fe0ca71b9006a09947c9cc203f9ab79";
        for (Map<String, Object> broken : List.of(
                Map.<String, Object>of("storageRef", storageRef, "mountRoot", MOUNT,
                        "continuity", "confirms", "unexpected", "value"),
                Map.<String, Object>of("storageRef", storageRef, "mountRoot", MOUNT,
                        "continuity", "maybe"))) {
            client.storage = broken;
            assertEquals(RuntimeObservation.Outcome.CONFLICT, join(subject.reconcile(placement.request(),
                    placement.seed(), placement.handle(), placement.lease())).getOutcome());
        }
    }

    @Test
    void transientStatesStayRetryableAndGoneNeverReplacesTheWorker() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "states");
        for (String state : List.of("STARTING", "UNKNOWN")) {
            client.observeState = state;
            RuntimeObservation observed = join(subject.reconcile(placement.request(),
                    placement.seed(), placement.handle(), placement.lease()));
            assertTrue(observed.getOutcome() == RuntimeObservation.Outcome.STARTING
                    || observed.getOutcome() == RuntimeObservation.Outcome.UNKNOWN, state);
            assertTrue(subject.isUsable(placement.lease()));
        }
        client.observeState = "GONE";
        assertEquals(RuntimeObservation.Outcome.CONFLICT, join(subject.reconcile(placement.request(),
                placement.seed(), placement.handle(), placement.lease())).getOutcome());
    }

    @Test
    void releaseIsANoOpAndNoCloseProofIsClaimed() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "release");
        int observes = client.observes.size();
        join(subject.release(placement.request(), placement.lease()));
        assertFalse(subject.supportsDrainedStop(),
                "step 3a must not claim a close proof: no Session may be left unclosable");
        assertEquals(observes, client.observes.size(), "release is not authority to stop a worker");
        assertTrue(subject.isUsable(placement.lease()));
    }

    @Test
    void theFamilyIsNamedOnce() {
        assertTrue(ExternalRuntimeKinds.isExternal(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH));
        assertTrue(ExternalRuntimeKinds.isExternal(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
        assertFalse(ExternalRuntimeKinds.isExternal("local-process"));
        assertFalse(ExternalRuntimeKinds.isExternal("external-workspace-typo"));
        assertFalse(ExternalRuntimeKinds.isWorkspace(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH));
        assertTrue(ExternalRuntimeKinds.isWorkspace(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
        assertTrue(ExternalRuntimeKinds.supported().contains(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH));
        assertTrue(ExternalRuntimeKinds.supported().contains(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
    }

    @Test
    void theEphemeralScratchHandleIsNeverReinterpretedAsAWorkspace() throws Exception {
        ExternalWorkspaceProvisioner subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement placement = place(subject, "handle");
        RuntimeResourceHandle scratchShaped = new RuntimeResourceHandle(
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH, placement.handle().getVersion(),
                placement.handle().getValue());
        assertTrue(subject.supportsStartupRecovery(placement.handle()));
        assertFalse(subject.supportsStartupRecovery(scratchShaped));
    }

    private static RuntimeBindingRecord draining(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            RuntimeResourceHandle handle, RuntimeLease lease, boolean drainRequested) {
        Instant now = Instant.now();
        return new RuntimeBindingRecord("binding-a", request, seed, 1, RuntimeBindingRecord.State.DRAINING,
                lease, handle, 1, drainRequested, "broker-a", now.plusSeconds(60), 1, 1, now, now, now);
    }

    @Test
    void savedOriginalDrainsAfterAdapterRestartWithoutObservingOrAllocating() throws Exception {
        var subject = provisioner(registration(PROVIDER, 3, MOUNT));
        var request = request();
        var seed = seed("stop");
        var handle = join(subject.ensureResource(request, seed, null));
        subject.close();
        subject = provisioner(registration(PROVIDER, 3, MOUNT));
        AtomicInteger attestations = new AtomicInteger();
        AtomicInteger stops = new AtomicInteger();
        AtomicReference<Map<String, Object>> stopBody = new AtomicReference<>();
        AtomicReference<com.sun.net.httpserver.Headers> stopHeaders = new AtomicReference<>();
        HttpServer worker = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        worker.createContext(ManagedContextProtocol.ATTEST_PATH, exchange -> {
            exchange.getRequestBody().readAllBytes();
            if (!("Bearer " + seed.getToken()).equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                exchange.sendResponseHeaders(403, -1);
                exchange.close();
                return;
            }
            attestations.incrementAndGet();
            byte[] bytes = JsonCodec.encode(ManagedContextProtocol.attestationResponse(ManagedContextProtocol.boot(request, seed)));
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        worker.createContext("/internal/managed-runtime/v2/publication:stop-drained", exchange -> {
            stopBody.set(JsonCodec.parseObject(exchange.getRequestBody().readAllBytes(), "stop"));
            stopHeaders.set(exchange.getRequestHeaders());
            stops.incrementAndGet();
            byte[] bytes = JsonCodec.encode(Map.of("protocolVersion", 2, "state", "drained", "receipts", List.of(),
                    "proof", Map.of("resourceId", "f120dc54-3d91-4dbb-84e3-3ca1127a883c", "kind", "external-publication",
                            "schemaVersion", 1, "byteLength", 231, "digest", "a".repeat(64))));
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        worker.start();
        try {
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:" + worker.getAddress().getPort()),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var binding = draining(request, seed, handle, lease, true);
            assertFalse(subject.supportsDrainedStop());
            assertTrue(subject.supportsDrainedStop(binding));
            Instant before = Instant.now();
            RuntimeDrainReceipt receipt = join(subject.stopDrained(binding));
            assertTrue(receipt.matches(binding));
            assertEquals("binding-a", receipt.bindingId());
            assertEquals(1, receipt.generation());
            assertEquals(seed.getProvisionRequestId(), receipt.provisionRequestId());
            assertEquals(handle, receipt.resourceHandle());
            assertFalse(receipt.stoppedAt().isBefore(before));
            assertFalse(receipt.stoppedAt().isAfter(Instant.now()));
            org.junit.jupiter.api.Assertions.assertNull(receipt.executionMode());
            org.junit.jupiter.api.Assertions.assertNull(receipt.stopScope());
            assertEquals(1, attestations.get());
            assertEquals(1, stops.get());
            assertEquals(Map.of("protocolVersion", 2, "channel", "all"), stopBody.get());
            assertEquals("3", stopHeaders.get().getFirst("X-Qwen-Managed-Storage-Revision"));
            assertTrue(client.provisions.isEmpty());
            assertTrue(client.observes.isEmpty());
        } finally {
            worker.stop(0);
        }
    }

    @Test
    void drainRefusesIncompleteAndChangedOriginalsBeforeNetworkOrProviderCalls() throws Exception {
        var subject = provisioner(registration(PROVIDER, 1, MOUNT));
        Placement original = place(subject, "original");
        int observations = client.observes.size();
        var changedScope = new RuntimeScope(TENANT, ALIAS, "2", MOUNT, CAPABILITY, "session");
        var changedRequest = new RuntimeProvisionRequest(changedScope, "isolation-a", ExternalWorkspaceProvisioner.KIND, ALIAS);
        var changedSeed = new RuntimeProvisionSeed(original.seed().getProvisionRequestId(), "runtime-a", "new-incarnation",
                original.seed().getLeaseId(), original.seed().getEpoch(), original.seed().getToken());
        var changedToken = new RuntimeProvisionSeed(original.seed().getProvisionRequestId(), "runtime-a", "incarnation-a",
                original.seed().getLeaseId(), original.seed().getEpoch(), "other-token");
        var tokenLease = new RuntimeLease("runtime-a", original.lease().getEndpoint(), changedToken.getToken(),
                changedToken.getLeaseId(), changedToken.getEpoch());
        var changedEndpoint = new RuntimeLease("runtime-a", URI.create("http://127.0.0.1:1"), original.seed().getToken(),
                original.seed().getLeaseId(), original.seed().getEpoch());
        for (RuntimeBindingRecord invalid : List.of(
                draining(original.request(), null, original.handle(), original.lease(), true),
                draining(original.request(), original.seed(), null, original.lease(), true),
                draining(original.request(), original.seed(), original.handle(), null, true),
                draining(changedRequest, original.seed(), original.handle(), original.lease(), true),
                draining(original.request(), changedSeed, original.handle(), original.lease(), true),
                draining(original.request(), changedToken, original.handle(), tokenLease, true),
                draining(original.request(), original.seed(), original.handle(), changedEndpoint, true))) {
            assertFalse(subject.supportsDrainedStop(invalid));
            var refused = failure(subject.stopDrained(invalid));
            assertEquals(409, refused.getStatusCode());
            assertEquals("runtime_broker_resource_conflict", refused.getCode());
            assertFalse(refused.isRetryable());
        }
        failure(subject.stopDrained(draining(original.request(), original.seed(), original.handle(), original.lease(), false)));
        assertEquals(observations, client.observes.size());
        assertEquals(1, client.provisions.size());
        subject.close();
        subject = provisioner(registration(PROVIDER, 2, MOUNT));
        var saved = draining(original.request(), original.seed(), original.handle(), original.lease(), true);
        assertFalse(subject.supportsDrainedStop(saved));
        failure(subject.stopDrained(saved));
        subject.close();
        subject = provisioner(registration("other-provider", 1, MOUNT));
        assertFalse(subject.supportsDrainedStop(saved));
        failure(subject.stopDrained(saved));
        assertEquals(observations, client.observes.size());
        assertEquals(1, client.provisions.size());
    }

    @Test
    void drainCapabilityPreservesRetryableRegistryFailure() throws Exception {
        var subject = provisioner(registration(PROVIDER, 1, MOUNT));
        var original = place(subject, "registry-outage");
        var saved = draining(original.request(), original.seed(), original.handle(), original.lease(), true);
        subject.close();
        var unavailable = new RuntimeBrokerException(503, "runtime_external_unavailable", "Registry read failed.", true);
        provisioner = new ExternalWorkspaceProvisioner(client, (tenant, alias) -> {
            throw unavailable;
        }, PROVIDER, Duration.ofSeconds(5));
        var failure = org.junit.jupiter.api.Assertions.assertThrows(RuntimeBrokerException.class,
                () -> provisioner.supportsDrainedStop(saved));
        org.junit.jupiter.api.Assertions.assertSame(unavailable, failure);
        assertEquals(503, failure.getStatusCode());
        assertTrue(failure.isRetryable());
        org.junit.jupiter.api.Assertions.assertSame(unavailable, failure(provisioner.stopDrained(saved)));
    }

    @Test
    void acquisitionRequiresPositiveContinuityButProvisionOnlyParityDoesNot() throws Exception {
        var subject = provisioner(registration(PROVIDER, 1, MOUNT));
        var original = place(subject, "acquire-missing");
        var ready = draining(original.request(), original.seed(), original.handle(), original.lease(), false)
                .withState(RuntimeBindingRecord.State.READY, original.lease(), Instant.now());
        int before = client.observes.size();
        assertEquals("runtime_external_unavailable", failure(subject.verifyAcquisition(ready)).getCode());
        assertEquals(before + 1, client.observes.size(), "One response supplies readiness and storage evidence");
        assertEquals(1, client.provisions.size());
        assertTrue(subject.isUsable(original.lease()), "Unknown acquisition evidence retains the original placement");
        client.storage = evidence("confirms", 1);
        failure(subject.verifyAcquisition(ready.withDrainRequested(true, Instant.now())));
        assertEquals(before + 1, client.observes.size(), "Drain refuses acquisition before observing");
        assertTrue(ExternalWorkspaceProvisioner.isWorkspaceRequest(original.request()));
        assertFalse(ExternalWorkspaceProvisioner.isWorkspaceRequest(new RuntimeProvisionRequest(scope(CAPABILITY),
                "isolation-a", ExternalRuntimeProvisioner.KIND, ALIAS)));
    }

    @Test
    void acquisitionAfterRestartObservesOriginalOnceThenIndependentlyAttests() throws Exception {
        var subject = provisioner(registration(PROVIDER, 1, MOUNT));
        var request = request();
        var seed = seed("acquisition");
        var handle = join(subject.ensureResource(request, seed, null));
        subject.close();
        subject = provisioner(registration(PROVIDER, 1, MOUNT));
        AtomicInteger attestations = new AtomicInteger();
        AtomicReference<Map<String, Object>> attestation = new AtomicReference<>(
                ManagedContextProtocol.attestationResponse(ManagedContextProtocol.boot(request, seed)));
        HttpServer worker = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        worker.createContext(ManagedContextProtocol.ATTEST_PATH, exchange -> {
            exchange.getRequestBody().readAllBytes();
            attestations.incrementAndGet();
            byte[] bytes = JsonCodec.encode(attestation.get());
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        worker.start();
        try {
            client.endpoint = "http://127.0.0.1:" + worker.getAddress().getPort();
            client.observeState = "RUNNING";
            client.storage = evidence("confirms", 1);
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create(client.endpoint), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var ready = draining(request, seed, handle, lease, false).withState(RuntimeBindingRecord.State.READY, lease, Instant.now());
            join(subject.verifyAcquisition(ready));
            assertEquals(1, client.observes.size());
            assertEquals(Map.of("protocolVersion", 1, "provisionRequestId", seed.getProvisionRequestId(),
                    "identity", handle.getValue().get("identity"), "handle", handle.getValue().get("provider")), client.observes.get(0));
            assertEquals(1, attestations.get());
            assertTrue(client.provisions.isEmpty());
            Map<String, Object> changed = new LinkedHashMap<>(attestation.get());
            changed.put("runtimeIncarnation", "another-incarnation");
            attestation.set(changed);
            failure(subject.verifyAcquisition(ready));
            assertEquals(2, attestations.get(), "Provider readiness alone cannot establish worker identity");
            client.storage = evidence("unknown", 1);
            failure(subject.verifyAcquisition(ready));
            assertEquals(2, attestations.get(), "Missing continuity refuses before worker acquisition attestation");
        } finally {
            worker.stop(0);
        }
    }

    private Map<String, Object> evidence(String continuity, long revision) {
        ExternalStorageRegistry.RegisteredExternalStorage storage =
                registration(PROVIDER, revision, MOUNT);
        return Map.of("storageRef", ExternalWorkspaceProvisioner.storageRef(storage),
                "mountRoot", storage.mountRoot(), "continuity", continuity);
    }

    /** Records provider traffic and answers from mutable per-test state. */
    private static final class RecordingClient implements ExternalRuntimeClient {
        private static final String ENDPOINT = "http://127.0.0.1:43190";
        private final List<Map<String, Object>> provisions = new ArrayList<>();
        private final List<Map<String, Object>> observes = new ArrayList<>();
        private Map<String, Object> provisionResponse = Map.of("protocolVersion", 1,
                "handle", Map.of("requestId", "request-a"), "endpoint", ENDPOINT);
        private String observeState = "STARTING";
        private String endpoint = ENDPOINT;
        private Map<String, Object> storage;

        @Override
        public CompletionStage<Map<String, Object>> provision(Map<String, Object> request) {
            provisions.add(request);
            return CompletableFuture.completedFuture(provisionResponse);
        }

        @Override
        public CompletionStage<Map<String, Object>> observe(Map<String, Object> request) {
            observes.add(request);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("protocolVersion", 1);
            response.put("state", observeState);
            if ("RUNNING".equals(observeState)) {
                response.put("endpoint", endpoint);
            }
            if (storage != null) {
                response.put("storage", storage);
            }
            return CompletableFuture.completedFuture(Map.copyOf(response));
        }

        @SuppressWarnings("unchecked")
        private Map<String, Object> boot() {
            return (Map<String, Object>) provisions.get(0).get("boot");
        }
    }
}
