package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore.Placement;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HarnessPoolConnectorTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void everyVerbKeepsItsPlacementAndObservationNeverCreatesOne() {
        var settings = settings();
        var placements = mock(HarnessPlacementStore.class);
        var saved = new AtomicReference<Placement>();
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        when(placements.assign(eq("tenant"), eq("session"), anyString(), anyString())).thenAnswer(call -> {
            var placement = new Placement("tenant", "session", "workspace", call.getArgument(2), call.getArgument(3), 1, "ACTIVE");
            saved.set(placement);
            return placement;
        });
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        HarnessDiscovery discovery = () -> new HarnessDiscovery.Snapshot(List.of(a, b), true);
        try (var pool = new HarnessPoolConnector(settings, placements, discovery,
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            assertThat(pool.inspectRecovery("tenant", "session", "prompt")).isNull();
            assertThat(pool.cachedRecoveryAttachment("tenant", "session")).isNull();
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            pool.createOrLoad("tenant", "session", false);
            pool.submit("tenant", "session", "prompt", List.of(), DIGEST);
            pool.cancelOriginalTurn("tenant", "session", "prompt");
            pool.runAutomationOperation("tenant", "session", Map.of("kind", "fire_run"));
            pool.runMessageOperation("tenant", "session", Map.of("kind", "receive"));
            pool.runChannelOperation("tenant", "session", Map.of("kind", "submit_input"));
            pool.runChildOperation("tenant", "session", Map.of("kind", "dispatch"));
            pool.readContextCompression("tenant", "session", "operation");
            verify(leafA).createOrLoad("tenant", "session", false);
            verify(leafA).submit("tenant", "session", "prompt", List.of(), DIGEST);
            verify(leafA).cancelOriginalTurn("tenant", "session", "prompt");
            verify(leafA).runAutomationOperation("tenant", "session", Map.of("kind", "fire_run"));
            verify(leafA).runMessageOperation("tenant", "session", Map.of("kind", "receive"));
            verify(leafA).runChannelOperation("tenant", "session", Map.of("kind", "submit_input"));
            verify(leafA).runChildOperation("tenant", "session", Map.of("kind", "dispatch"));
            verify(leafA).readContextCompression("tenant", "session", "operation");
            verify(leafB, never()).createOrLoad(anyString(), anyString(), eq(false));
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
        }
    }

    @Test
    void discoveryUncertaintyPausesPlacementWhileOriginalCachedOwnerRemainsUsable() {
        var placements = mock(HarnessPlacementStore.class);
        var endpoint = endpoint("a", 4101);
        var leaf = leaf();
        var client = client("a");
        var snapshot = new AtomicReference<>(new HarnessDiscovery.Snapshot(List.of(endpoint), true));
        String boot = client.capabilities().getBootId();
        when(placements.get("tenant", "held")).thenReturn(new Placement("tenant", "held", "workspace", "a", boot, 2, "ACTIVE"));
        try (var pool = new HarnessPoolConnector(settings(), placements, snapshot::get, ignored -> leaf,
                null, null, ignored -> client)) {
            pool.refresh();
            snapshot.set(new HarnessDiscovery.Snapshot(List.of(endpoint), false));
            pool.refresh();
            pool.cancel("tenant", "held");
            verify(leaf).cancel("tenant", "held");
            assertThatThrownBy(() -> pool.createOrLoad("tenant", "new", false))
                    .hasMessageContaining("No compatible Harness owner");
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Test
    void ownershipReleaseNeverReassignsOrTargetsASuccessorEpoch() {
        var placements = mock(HarnessPlacementStore.class);
        var endpoint = endpoint("a", 4101);
        var leaf = leaf();
        var client = client("a");
        String boot = client.capabilities().getBootId();
        var saved = new AtomicReference<>(new Placement("tenant", "session", "workspace", "a", boot, 2, "QUIESCING"));
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        when(placements.releaseReceipt("tenant", "session", 2, "operation")).thenReturn(null);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(endpoint), true), ignored -> leaf,
                null, null, ignored -> client)) {
            pool.refresh();
            pool.releaseOwnership("tenant", "session", "operation", 2);
            verify(leaf).releaseOwnership("tenant", "session", "operation", 2);
            saved.set(new Placement("tenant", "session", "workspace", "a", boot, 3, "ACTIVE"));
            assertThatThrownBy(() -> pool.releaseOwnership("tenant", "session", "operation", 2))
                    .hasMessageContaining("Original Harness placement");
            var receipt = Map.<String, Object>of("operationId", "operation", "placementEpoch", 2L, "state", "RELEASED");
            when(placements.releaseReceipt("tenant", "session", 2, "operation")).thenReturn(receipt);
            assertThat(pool.releaseOwnership("tenant", "session", "operation", 2)).isEqualTo(receipt);
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
            verify(leaf, never()).releaseOwnership("tenant", "session", "operation", 3);
        }
    }

    @Test
    void releasedPlacementRequiresStoreCasBeforeSameBootReuse() {
        var placements = mock(HarnessPlacementStore.class);
        var endpoint = endpoint("a", 4101);
        var leaf = leaf();
        var client = client("a");
        String boot = client.capabilities().getBootId();
        var released = new Placement("tenant", "session", "workspace", "a", boot, 2, "RELEASED");
        var successor = new Placement("tenant", "session", "workspace", "a", boot, 3, "ACTIVE");
        when(placements.get("tenant", "session")).thenReturn(released);
        when(placements.takeover("tenant", "session", released, "a", boot)).thenReturn(successor);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(endpoint), true), ignored -> leaf,
                null, null, ignored -> client)) {
            pool.refresh();
            pool.createOrLoad("tenant", "session", true);
            verify(placements).takeover("tenant", "session", released, "a", boot);
            verify(leaf).createOrLoad("tenant", "session", true);
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Test
    void lifecycleHandoffUsesCanonicalOperationInsteadOfOrdinaryPlacementAdmission() {
        var placements = mock(HarnessPlacementStore.class);
        var endpoint = endpoint("a", 4101);
        var leaf = leaf();
        var client = client("a");
        String boot = client.capabilities().getBootId();
        var released = new Placement("tenant", "session", "workspace", "a", boot, 2, "RELEASED");
        var successor = new Placement("tenant", "session", "workspace", "a", boot, 3, "ACTIVE");
        var operation = new OperationRecord("tenant", "session", "close", OperationKind.CLOSE, "request", "PENDING",
                "ADMITTED", "LEASED", "ACTIVE", null, "worker", 7, 0, null, 1);
        when(placements.get("tenant", "session")).thenReturn(released);
        when(placements.takeoverForLifecycle(operation, released, "a", boot)).thenReturn(successor);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(endpoint), true), ignored -> leaf,
                null, null, ignored -> client)) {
            pool.refresh();
            pool.settleLifecycle(operation);
            verify(placements).takeoverForLifecycle(operation, released, "a", boot);
            verify(leaf).settleLifecycle(operation);
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        }
    }

    @Test
    void shutdownClosesAClientRegisteredAfterItsInitialClosedCheck() throws Exception {
        var placements = mock(HarnessPlacementStore.class);
        var endpoint = endpoint("a", 4101);
        var leaf = leaf();
        var entered = new CountDownLatch(1);
        var continueRegistration = new CountDownLatch(1);
        var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(endpoint), true), ignored -> {
                    entered.countDown();
                    try {
                        if (!continueRegistration.await(5, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Timed out waiting for shutdown");
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(interrupted);
                    }
                    return leaf;
                }, null, null, ignored -> client("a"));
        var refresh = new Thread(pool::refresh);
        refresh.start();
        try {
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            pool.close();
            continueRegistration.countDown();
            refresh.join(5_000);
            assertThat(refresh.isAlive()).isFalse();
            verify(leaf).close();
            assertThatThrownBy(() -> pool.createOrLoad("tenant", "session", false))
                    .hasMessageContaining("No compatible Harness owner");
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        } finally {
            continueRegistration.countDown();
            pool.close();
        }
    }

    @Test
    void rejectsUnboundPoolAndRemotePlaintextEvenWhenLegacyOverrideIsAllowed() {
        var settings = settings();
        settings.getSessionStore().setBindingKey("");
        assertThatThrownBy(() -> new HarnessPoolConnector(settings, mock(HarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(), true), ignored -> leaf(), null, null, ignored -> client("a")))
                .hasMessageContaining("binding key");
        settings.getSessionStore().setBindingKey("binding-key-".repeat(4));
        settings.getSessionStore().setEnabled(false);
        assertThatThrownBy(() -> new HarnessPoolConnector(settings, mock(HarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(), true), ignored -> leaf(), null, null, ignored -> client("a")))
                .hasMessageContaining("enabled Session Store");
        assertThatThrownBy(() -> HarnessPoolConnector.validateEndpoint(
                new HarnessDiscovery.Endpoint("remote", URI.create("http://10.0.0.2:4170"), true), null))
                .hasMessageContaining("mTLS");
        assertThatThrownBy(() -> HarnessPoolConnector.validateEndpoint(
                new HarnessDiscovery.Endpoint("remote", URI.create("https://10.0.0.2:4170"), true), null))
                .hasMessageContaining("mTLS");
    }

    private static QwenHostedHarnessConnector leaf() {
        var leaf = mock(QwenHostedHarnessConnector.class);
        doAnswer(call -> ((Supplier<?>) call.getArgument(1)).get()).when(leaf).withPlacement(any(), any());
        when(leaf.attachedSessions()).thenReturn(List.of());
        return leaf;
    }

    private static HarnessDiscovery.Endpoint endpoint(String id, int port) {
        return new HarnessDiscovery.Endpoint(id, URI.create("http://127.0.0.1:" + port), true);
    }

    private static HostedHarnessClient client(String id) {
        var client = mock(HostedHarnessClient.class);
        var capabilities = mock(HostedHarnessCapabilities.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(UUID.randomUUID().toString());
        when(capabilities.getInstanceId()).thenReturn(id);
        when(capabilities.getFeatures()).thenReturn(List.of("harness-pool-owner/1", "harness-instance-lifecycle/1"));
        when(capabilities.getLifecycleV2Profiles()).thenReturn(List.of());
        when(client.readInstance()).thenReturn(Map.of("state", "ACCEPTING"));
        return client;
    }

    private static ManagedAgentProperties settings() {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setToken("test-token");
        properties.getHarness().setCapabilityDigest(DIGEST);
        properties.getSessionStore().setBindingKey("binding-key-".repeat(4));
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setWorkspaceId("workspace");
        return properties;
    }
}
