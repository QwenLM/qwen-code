package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessAttachmentLostFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.JdbcHarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore.Placement;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HarnessPoolConnectorTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void vanishedAdmissionReselectsPlacementAndPassesAFreshRecoveryCall() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var first = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, "ACTIVE");
        var fresh = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 2, "ACTIVE");
        var current = new AtomicReference<>(first);
        when(placements.get("tenant", "session")).thenAnswer(call -> current.get());
        var body = Map.<String, Object>of("kind", "submit_input");
        when(leafA.runChannelOperation("tenant", "session", body)).thenAnswer(call -> {
            current.set(fresh);
            throw new HarnessAttachmentLostFailure(null);
        });
        when(leafB.runChannelOperation("tenant", "session", body)).thenReturn(Map.of("accepted", true));
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            assertThat(pool.runChannelOperation("tenant", "session", body)).containsEntry("accepted", true);
            var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
            verify(leafB).withPlacement(routed.capture(), any());
            assertThat(routed.getValue().placement().getPlacementEpoch()).isEqualTo(2);
            assertThat(routed.getValue().placement().getInstanceId()).isEqualTo("b");
            assertThat(routed.getValue().recoveringAdmission()).isTrue();
            verify(leafA).runChannelOperation("tenant", "session", body);
            verify(leafB).runChannelOperation("tenant", "session", body);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void publicChildAgentsUseTheNegotiatedPoolCapability(boolean supported) {
        // D5′: a pooled worker that advertises the feature admits children.
        var features = new java.util.ArrayList<>(List.of(
                "harness-pool-owner/1", "harness-instance-lifecycle/1", "approval-selection/1"));
        if (supported) {
            features.add("public-child-agents/1");
        }
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.capabilities().getFeatures()).thenReturn(features);
        when(clientA.capabilities().getLifecycleV2Profiles())
                .thenReturn(List.of("hosted-workspace-shell/1"));
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            assertThat(pool.supportsPublicChildAgents()).isFalse();
            pool.refresh();
            assertThat(pool.supportsPublicChildAgents()).isEqualTo(supported);
        }
    }

    @Test
    void publicChildAgentsRequireApprovalSelectionAndShellLifecycleV2() {
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.capabilities().getFeatures()).thenReturn(
                List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "public-child-agents/1"));
        when(clientA.capabilities().getLifecycleV2Profiles())
                .thenReturn(List.of("hosted-workspace-shell/1"));
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            pool.refresh();
            // The token builds on approval-selection/1.
            assertThat(pool.supportsPublicChildAgents()).isFalse();
        }
        when(clientA.capabilities().getFeatures()).thenReturn(
                List.of("harness-pool-owner/1", "harness-instance-lifecycle/1",
                        "public-child-agents/1", "approval-selection/1"));
        when(clientA.capabilities().getLifecycleV2Profiles()).thenReturn(List.of());
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            pool.refresh();
            // Without the negotiated Shell v2 profile the lifecycle gate refuses.
            assertThat(pool.supportsPublicChildAgents()).isFalse();
        }
    }

    @ParameterizedTest
    @MethodSource("filesLifecycleV2Cases")
    void filesLifecycleRidesTheNegotiatedV2ProfilesAndTheAvailabilityGate(
            List<String> profiles, boolean filesEnabled, boolean supported) {
        // D3: ordinary files settles on the negotiated lifecycle v2 profiles,
        // not the saved v1 protocol. Reverting the files arm to
        // contract.lifecycle()==1 or dropping the isWorkspaceFilesAvailable()
        // conjunct reds these cases.
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.capabilities().getLifecycleV2Profiles()).thenReturn(profiles);
        var settings = settings();
        settings.getHarness().setWorkspaceFilesEnabled(filesEnabled);
        try (var pool = new HarnessPoolConnector(settings, mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            assertThat(pool.supportsLifecycle(WorkspaceToolProfiles.FILES)).isFalse();
            pool.refresh();
            assertThat(pool.supportsLifecycle(WorkspaceToolProfiles.FILES)).isEqualTo(supported);
            assertThat(pool.supportsLifecycle()).isEqualTo(supported);
        }
    }

    private static Stream<Arguments> filesLifecycleV2Cases() {
        return Stream.of(
                Arguments.of(List.of("hosted-workspace-files/1", "hosted-workspace-shell/1"), true, true),
                Arguments.of(List.of(), true, false),
                Arguments.of(List.of("hosted-workspace-files/1"), false, false));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void personalMemoryUsesTheNegotiatedPoolCapability(boolean supported) {
        var features = new java.util.ArrayList<>(List.of("harness-pool-owner/1", "harness-instance-lifecycle/1"));
        if (supported) {
            features.add("session-memory/1");
        }
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var clientA = client("a");
        var clientB = client("b");
        when(clientA.capabilities().getFeatures()).thenReturn(features);
        when(clientB.capabilities().getFeatures()).thenReturn(features);
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true), ignored -> leaf(), null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            assertThat(pool.supportsPersonalMemory()).isFalse();
            pool.refresh();
            assertThat(pool.supportsPersonalMemory()).isEqualTo(supported);
        }
    }

    @Test
    void sessionAwareClientFilesDelegatesToAReachableMember() {
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.capabilities().getFeatures()).thenReturn(
                List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "client-files/1"));
        var leafA = leaf();
        var session = new SessionRecord("tenant", "session", "qwen-code", "title", "ACTIVE",
                null, null, 0, 0, 1, 1, null, 1);
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leafA, null, null,
                ignored -> clientA)) {
            // No negotiated contract yet: the feature gate refuses before any
            // member is consulted.
            assertThat(pool.supportsClientFiles(session)).isFalse();
            pool.refresh();
            // The pool answers with the reachable member's session-aware verdict
            // (not the parameterless capability), so a foregroundOnly refusal on
            // the member is not masked by the pool.
            when(leafA.supportsClientFiles(session)).thenReturn(false);
            assertThat(pool.supportsClientFiles(session)).isFalse();
            when(leafA.supportsClientFiles(session)).thenReturn(true);
            assertThat(pool.supportsClientFiles(session)).isTrue();
            verify(leafA, times(2)).supportsClientFiles(session);
        }
    }

    @Test
    void extensionCommandsKeepTheSavedOwnerAndNegotiatedCapability() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var features = List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "session-extension-packages/1");
        when(clientA.capabilities().getFeatures()).thenReturn(features);
        when(clientB.capabilities().getFeatures()).thenReturn(features);
        String ownerBoot = clientB.capabilities().getBootId();
        when(placements.get("tenant", "held")).thenReturn(new Placement("tenant", "held", "workspace", "b",
                ownerBoot, 2, "ACTIVE"));
        Map<String, Object> command = Map.of("operationId", "original");
        Map<String, Object> result = Map.of("phase", "active");
        when(leafB.applyExtensions("tenant", "held", command)).thenReturn(result);
        when(leafB.continueExtensionOperation("tenant", "held", "original", true)).thenReturn(result);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            assertThat(pool.supportsSessionExtensions()).isFalse();
            pool.refresh();
            assertThat(pool.supportsSessionExtensions()).isTrue();
            assertThat(pool.applyExtensions("tenant", "held", command)).isEqualTo(result);
            assertThat(pool.continueExtensionOperation("tenant", "held", "original", true)).isEqualTo(result);
            verify(leafA, never()).applyExtensions(anyString(), anyString(), any());
            verify(leafA, never()).continueExtensionOperation(anyString(), anyString(), anyString(), eq(true));
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
        }
    }

    @Test
    void everyVerbKeepsItsPlacementAndObservationNeverCreatesOne() {
        var settings = settings();
        var placements = mock(JdbcHarnessPlacementStore.class);
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
    void unattachedRecoveryReadsOnlyTheActiveOwnerAndRejectsAChangedPlacement() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var session = new SessionRecord("tenant", "session", "qwen-code", null, "ACTIVE",
                null, null, 0, 0, 1, 1, null, 1);
        var original = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 1, "ACTIVE");
        var successor = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 2, "ACTIVE");
        var saved = new AtomicReference<Placement>();
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            assertThat(pool.inspectUnattachedRecovery(session, "prompt")).isNull();
            saved.set(original);
            when(leafB.inspectUnattachedRecovery(session, "prompt")).thenAnswer(call -> {
                saved.set(successor);
                return null;
            });
            assertThatThrownBy(() -> pool.inspectUnattachedRecovery(session, "prompt"))
                    .hasMessageContaining("No compatible Harness owner");
            var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
            verify(leafB).withPlacement(routed.capture(), any());
            assertThat(routed.getValue().placement().getPlacementEpoch()).isEqualTo(original.epoch());
            verify(leafB).inspectUnattachedRecovery(session, "prompt");
            verify(leafA, never()).inspectUnattachedRecovery(any(), anyString());
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
        }
    }

    @Test
    void discoveryUncertaintyPausesPlacementWhileOriginalCachedOwnerRemainsUsable() {
        var placements = mock(JdbcHarnessPlacementStore.class);
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
    void refreshReapsDepartedPlacementWithoutOpeningAnAttachment() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var b = endpoint("b", 4102);
        var leafB = leaf();
        var clientB = client("b");
        var expected = new Placement("tenant", "session", "workspace", "a", "old-boot", 3, "QUIESCING");
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 4, "ACTIVE");
        when(placements.findExpiredSuspensions(Set.of("b"), 32)).thenReturn(List.of(expected));
        when(placements.takeover("tenant", "session", expected, "b", successor.bootId())).thenReturn(successor);
        when(placements.get("tenant", "session")).thenReturn(successor);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(b), true), ignored -> leafB, null, null,
                ignored -> clientB)) {
            pool.refresh();
            verify(placements).takeover("tenant", "session", expected, "b", successor.bootId());
            verify(leafB, never()).createOrLoad(anyString(), anyString(), eq(true));

            pool.createOrLoad("tenant", "session", true);
            verify(leafB).createOrLoad("tenant", "session", true);
        }
    }

    @Test
    void knownUnreachableOwnerIsOfferedOnlyWithTheStoreProof() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var expected = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, "ACTIVE");
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 2, "ACTIVE");
        when(clientA.readInstance()).thenThrow(new RuntimeException("temporary outage"));
        when(placements.findExpiredSuspensions(Set.of("b"), 32)).thenReturn(List.of(expected));
        when(placements.takeover("tenant", "session", expected, "b", successor.bootId())).thenReturn(successor);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            verify(placements).findExpiredSuspensions(Set.of("b"), 32);
            verify(placements).takeover("tenant", "session", expected, "b", successor.bootId());
        }
    }

    @Test
    void healthyConfiguredOwnerStaysExcludedFromTheReaper() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            verify(placements).findExpiredSuspensions(Set.of("a", "b"), 32);
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
        }
    }

    @Test
    void uncertainDiscoveryDoesNotInvokeTheReaper() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a), false), ignored -> leaf(), null, null,
                ignored -> client("a"))) {
            pool.refresh();
            verify(placements, never()).findExpiredSuspensions(any(), eq(32));
        }
    }

    @Test
    void noAcceptingSuccessorSkipsTheReaper() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.readInstance()).thenReturn(Map.of("state", "QUIESCING"));
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            pool.refresh();
            verify(placements, never()).findExpiredSuspensions(any(), eq(32));
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"QUIESCING", "DRAINED"})
    void observedDrainMovesANeverAcquiredPlacementThroughTheStore(String state) {
        var settings = settings();
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var first = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, "ACTIVE");
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 2, "ACTIVE");
        var saved = new AtomicReference<>(first);
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        when(placements.hasUnreleasedOwnership(first.instanceId(), first.bootId())).thenReturn(true);
        when(placements.takeover("tenant", "session", first, "b", successor.bootId())).thenAnswer(call -> {
            saved.set(successor);
            return successor;
        });
        var quiescing = mock(DaemonHttpException.class);
        when(quiescing.getStatusCode()).thenReturn(409);
        when(quiescing.getErrorCode()).thenReturn("hosted_harness_quiescing");
        when(leafA.createOrLoad("tenant", "session", false)).thenThrow(quiescing);
        try (var pool = new HarnessPoolConnector(settings, placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            assertThatThrownBy(() -> pool.createOrLoad("tenant", "session", false)).isSameAs(quiescing);
            when(clientA.readInstance()).thenReturn(Map.of("state", state));
            pool.refresh();
            for (int retry = 0; retry < 6; retry++) {
                pool.createOrLoad("tenant", "session", false);
            }
            assertThat(saved.get()).isEqualTo(successor);
            verify(placements).takeover("tenant", "session", first, "b", successor.bootId());
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            verify(leafA).createOrLoad("tenant", "session", false);
            verify(leafB, times(6)).createOrLoad("tenant", "session", false);
            var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
            verify(leafB, times(6)).withPlacement(routed.capture(), any());
            assertThat(routed.getAllValues()).allSatisfy(call -> {
                assertThat(call.placement().getInstanceId()).isEqualTo("b");
                assertThat(call.placement().getBootId()).isEqualTo(successor.bootId());
                assertThat(call.placement().getPlacementEpoch()).isEqualTo(2);
                new WriterCredentialPolicy(settings).requirePlacement("tenant", "workspace", "session",
                        "b", successor.bootId(), 2, call.writerToken());
            });
        }
    }

    @Test
    void explicitDrainChangesPlacementEligibilityBeforeTheNextRefresh() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var first = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, "ACTIVE");
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 2, "ACTIVE");
        when(placements.get("tenant", "session")).thenReturn(first);
        when(placements.takeover("tenant", "session", first, "b", successor.bootId())).thenReturn(successor);
        String operation = UUID.randomUUID().toString();
        when(clientA.drainInstance(operation)).thenReturn(Map.of("state", "DRAINED"));
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            pool.drainInstance("a", operation);
            pool.createOrLoad("tenant", "session", false);
            verify(placements).takeover("tenant", "session", first, "b", successor.bootId());
            verify(leafA, never()).createOrLoad(anyString(), anyString(), eq(false));
            verify(leafB).createOrLoad("tenant", "session", false);
        }
    }

    @ParameterizedTest
    @CsvSource({"ACTIVE,true,harness_owner_still_live,true", "ACTIVE,true,harness_placement_changed,false",
            "QUIESCING,true,harness_owner_still_live,false", "ACTIVE,false,harness_owner_still_live,false"})
    void onlyAReachableActiveLiveOwnerKeepsItsCompletionCallsDuringDrain(
            String state, boolean reachable, String code, boolean keepsOwner) {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var owner = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, state);
        when(placements.get("tenant", "session")).thenReturn(owner);
        when(placements.hasUnreleasedOwnership(owner.instanceId(), owner.bootId())).thenReturn(true);
        var refusal = new ManagedAgentException(409, code, "Writer fence refused takeover");
        when(placements.takeover("tenant", "session", owner, "b", clientB.capabilities().getBootId())).thenThrow(refusal);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a, b), true),
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            if (reachable) {
                when(clientA.readInstance()).thenReturn(Map.of("state", "QUIESCING"));
            } else {
                when(clientA.readInstance()).thenThrow(mock(DaemonTransportException.class));
            }
            pool.refresh();
            if (keepsOwner) {
                var response = JsonNodeFactory.instance.objectNode();
                pool.stream("tenant", "session", 0, "cursor");
                pool.resolveAction("tenant", "session", "action", response);
                pool.cancel("tenant", "session");
                verify(leafA).stream("tenant", "session", 0, "cursor");
                verify(leafA).resolveAction("tenant", "session", "action", response);
                verify(leafA).cancel("tenant", "session");
                var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
                verify(leafA, times(3)).withPlacement(routed.capture(), any());
                assertThat(routed.getAllValues()).allSatisfy(call -> {
                    assertThat(call.placement().getInstanceId()).isEqualTo("a");
                    assertThat(call.placement().getBootId()).isEqualTo(owner.bootId());
                    assertThat(call.placement().getPlacementEpoch()).isEqualTo(owner.epoch());
                });
            } else {
                assertThatThrownBy(() -> pool.stream("tenant", "session", 0, "cursor")).isSameAs(refusal);
                verify(leafA, never()).stream(anyString(), anyString(), eq(0L), anyString());
            }
            verify(leafB, never()).stream(anyString(), anyString(), eq(0L), anyString());
            verify(leafB, never()).resolveAction(anyString(), anyString(), anyString(), any());
            verify(leafB, never()).cancel(anyString(), anyString());
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        }
    }

    @ParameterizedTest
    @CsvSource({"RELEASED,false", "QUIESCING,true", "ACTIVE,true"})
    void aDrainingOwnerWithNoSuccessorServesOnlyThePlacementsItStillHolds(String state, boolean keepsOwner) {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var owner = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 2, state);
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 3, "ACTIVE");
        var saved = new AtomicReference<>(owner);
        var snapshot = new AtomicReference<>(new HarnessDiscovery.Snapshot(List.of(a), true));
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        // Another Session still on the draining owner keeps it a member.
        when(placements.hasUnreleasedOwnership(owner.instanceId(), owner.bootId())).thenReturn(true);
        when(placements.takeover("tenant", "session", owner, "b", successor.bootId())).thenAnswer(call -> {
            saved.set(successor);
            return successor;
        });
        Map<String, Object> body = Map.of("kind", "fire_run");
        try (var pool = new HarnessPoolConnector(settings(), placements, snapshot::get,
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            when(clientA.readInstance()).thenReturn(Map.of("state", "DRAINED"));
            pool.refresh();
            if (keepsOwner) {
                pool.runAutomationOperation("tenant", "session", body);
                verify(leafA).runAutomationOperation("tenant", "session", body);
                var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
                verify(leafA).withPlacement(routed.capture(), any());
                assertThat(routed.getValue().placement().getInstanceId()).isEqualTo("a");
                assertThat(routed.getValue().placement().getPlacementEpoch()).isEqualTo(2);
            } else {
                // Nothing holds a released Session: the caller meets the
                // pool's 503, not the drained owner's not-found (#15795).
                assertThatThrownBy(() -> pool.runAutomationOperation("tenant", "session", body))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus()).isEqualTo(503);
                            assertThat(error.getCode()).isEqualTo("harness_pool_unavailable");
                        });
                verify(leafA, never()).withPlacement(any(), any());
                verify(leafA, never()).runAutomationOperation(anyString(), anyString(), any());
                snapshot.set(new HarnessDiscovery.Snapshot(List.of(a, b), true));
                pool.refresh();
                pool.runAutomationOperation("tenant", "session", body);
                verify(placements).takeover("tenant", "session", owner, "b", successor.bootId());
                verify(leafB).runAutomationOperation("tenant", "session", body);
            }
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void aKnownUnreachableOwnerWaitsForCapacityWithoutFurtherRpcs(boolean refreshFailure) {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var b = endpoint("b", 4102);
        var leafA = leaf();
        var leafB = leaf();
        var clientA = client("a");
        var clientB = client("b");
        var first = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1, "ACTIVE");
        var successor = new Placement("tenant", "session", "workspace", "b", clientB.capabilities().getBootId(), 2, "ACTIVE");
        var saved = new AtomicReference<>(first);
        var snapshot = new AtomicReference<>(new HarnessDiscovery.Snapshot(List.of(a), true));
        when(placements.get("tenant", "session")).thenAnswer(call -> saved.get());
        when(placements.hasUnreleasedOwnership(first.instanceId(), first.bootId())).thenReturn(true);
        when(placements.takeover("tenant", "session", first, "b", successor.bootId())).thenAnswer(call -> {
            saved.set(successor);
            return successor;
        });
        var transport = mock(DaemonTransportException.class);
        try (var pool = new HarnessPoolConnector(settings(), placements, snapshot::get,
                endpoint -> endpoint.instanceId().equals("a") ? leafA : leafB, null, null,
                endpoint -> endpoint.instanceId().equals("a") ? clientA : clientB)) {
            pool.refresh();
            if (refreshFailure) {
                when(clientA.readInstance()).thenThrow(transport);
                pool.refresh();
            } else {
                when(leafA.createOrLoad("tenant", "session", false)).thenThrow(transport);
                assertThatThrownBy(() -> pool.createOrLoad("tenant", "session", false)).isSameAs(transport);
            }
            for (int retry = 0; retry < 6; retry++) {
                assertThatThrownBy(() -> pool.createOrLoad("tenant", "session", false))
                        .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                            assertThat(error.getStatus()).isEqualTo(503);
                            assertThat(error.getCode()).isEqualTo("harness_pool_unavailable");
                        });
            }
            assertThat(saved.get()).isEqualTo(first);
            verify(leafA, times(refreshFailure ? 0 : 1)).createOrLoad("tenant", "session", false);
            verify(placements, never()).assign(anyString(), anyString(), anyString(), anyString());
            verify(placements, never()).takeover(anyString(), anyString(), any(), anyString(), anyString());
            doThrow(transport).when(clientA).readInstance();
            snapshot.set(new HarnessDiscovery.Snapshot(List.of(a, b), true));
            pool.refresh();
            pool.createOrLoad("tenant", "session", false);
            assertThat(saved.get()).isEqualTo(successor);
            verify(placements).takeover("tenant", "session", first, "b", successor.bootId());
            verify(leafB).createOrLoad("tenant", "session", false);
        }
    }

    @Test
    void ownershipReleaseNeverReassignsOrTargetsASuccessorEpoch() {
        var placements = mock(JdbcHarnessPlacementStore.class);
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
        var placements = mock(JdbcHarnessPlacementStore.class);
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
        var placements = mock(JdbcHarnessPlacementStore.class);
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
        var placements = mock(JdbcHarnessPlacementStore.class);
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
        assertThatThrownBy(() -> new HarnessPoolConnector(settings, mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(), true), ignored -> leaf(), null, null, ignored -> client("a")))
                .hasMessageContaining("binding key");
        settings.getSessionStore().setBindingKey("binding-key-".repeat(4));
        settings.getSessionStore().setEnabled(false);
        assertThatThrownBy(() -> new HarnessPoolConnector(settings, mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(), true), ignored -> leaf(), null, null, ignored -> client("a")))
                .hasMessageContaining("enabled Session Store");
        assertThatThrownBy(() -> HarnessPoolConnector.validateEndpoint(
                new HarnessDiscovery.Endpoint("remote", URI.create("http://10.0.0.2:4170"), true), null))
                .hasMessageContaining("mTLS");
        assertThatThrownBy(() -> HarnessPoolConnector.validateEndpoint(
                new HarnessDiscovery.Endpoint("remote", URI.create("https://10.0.0.2:4170"), true), null))
                .hasMessageContaining("mTLS");
    }

    @ParameterizedTest
    @CsvSource({"true,true,true", "false,true,false", "true,false,false"})
    void releasedPlacementWaitsForAClaimOnlyWithPullOnAndAWorkPullPool(boolean enabled, boolean advertised,
            boolean gated) {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var leafA = leaf();
        var clientA = client("a");
        if (advertised) {
            when(clientA.capabilities().getFeatures())
                    .thenReturn(List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "work-pull/1"));
        }
        String boot = clientA.capabilities().getBootId();
        var released = new Placement("tenant", "session", "workspace", "a", boot, 1, "RELEASED");
        when(placements.get("tenant", "session")).thenReturn(released);
        when(placements.recordDemand("tenant", "session")).thenReturn(1_000L);
        when(placements.takeover(eq("tenant"), eq("session"), eq(released), eq("a"), anyString()))
                .thenReturn(new Placement("tenant", "session", "workspace", "a", boot, 2, "ACTIVE"));
        when(placements.assign(eq("tenant"), eq("fresh"), eq("a"), anyString()))
                .thenReturn(new Placement("tenant", "fresh", "workspace", "a", boot, 1, "ACTIVE"));
        var demands = new AtomicInteger();
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leafA, null, null,
                ignored -> clientA)) {
            if (enabled) {
                pool.enableWorkPull();
            }
            pool.onClaimDemand(demands::incrementAndGet);
            pool.refresh();
            pool.recoverForWake("tenant", "fresh");
            verify(placements, never()).recordDemand("tenant", "fresh");
            if (gated) {
                assertThatThrownBy(() -> pool.recoverForWake("tenant", "session"))
                        .isInstanceOf(ManagedAgentException.class).extracting("code")
                        .isEqualTo("harness_placement_released");
                assertThat(demands).hasValue(1);
                verify(placements, never()).takeover(any(), any(), any(), any(), any());
                when(placements.recordDemand("tenant", "session")).thenReturn(30_000L);
            }
            pool.recoverForWake("tenant", "session");
            verify(placements).takeover(eq("tenant"), eq("session"), eq(released), eq("a"), anyString());
            verify(leafA).recoverForWake("tenant", "session");
            if (!gated) {
                verify(placements, never()).recordDemand(anyString(), anyString());
            }
        }
    }

    @Test
    void claimDemandIsRecordedEvenWithoutAnAcceptingPushMember() {
        var placements = mock(JdbcHarnessPlacementStore.class);
        var a = endpoint("a", 4101);
        var clientA = client("a");
        when(clientA.capabilities().getFeatures())
                .thenReturn(List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "work-pull/1"));
        when(clientA.readInstance()).thenReturn(Map.of("state", "QUIESCING"));
        var released = new Placement("tenant", "session", "workspace", "a", clientA.capabilities().getBootId(), 1,
                "RELEASED");
        when(placements.get("tenant", "session")).thenReturn(released);
        when(placements.hasUnreleasedOwnership("a", released.bootId())).thenReturn(true);
        when(placements.recordDemand("tenant", "session")).thenReturn(0L);
        try (var pool = new HarnessPoolConnector(settings(), placements,
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leaf(), null, null,
                ignored -> clientA)) {
            pool.enableWorkPull();
            pool.refresh();
            assertThat(pool.acceptsWorkPullClaims("a", released.bootId())).isFalse();
            assertThat(pool.acceptsWorkPullReoffers("a", released.bootId())).isTrue();
            assertThatThrownBy(() -> pool.recoverForWake("tenant", "session"))
                    .isInstanceOf(ManagedAgentException.class).extracting("code")
                    .isEqualTo("harness_placement_released");
            verify(placements).recordDemand("tenant", "session");
            when(placements.recordDemand("tenant", "session")).thenReturn(30_000L);
            assertThatThrownBy(() -> pool.recoverForWake("tenant", "session"))
                    .isInstanceOf(ManagedAgentException.class).extracting("code")
                    .isEqualTo("harness_pool_unavailable");
        }
    }

    @Test
    void workPullClaimsComeFromNegotiatedMembersAndCarryTheClaimedPlacement() {
        var a = endpoint("a", 4101);
        var leafA = leaf();
        var clientA = client("a");
        when(clientA.capabilities().getFeatures())
                .thenReturn(List.of("harness-pool-owner/1", "harness-instance-lifecycle/1", "work-pull/1"));
        String boot = clientA.capabilities().getBootId();
        when(leafA.passiveWakeLoad("tenant", "session")).thenReturn(Map.of("sessionId", "session"));
        try (var pool = new HarnessPoolConnector(settings(), mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(a), true), ignored -> leafA, null, null,
                ignored -> clientA)) {
            pool.refresh();
            assertThat(pool.acceptsWorkPullClaims("a", boot)).isFalse();
            assertThat(pool.acceptsWorkPullReoffers("a", boot)).isFalse();
            pool.enableWorkPull();
            assertThat(pool.acceptsWorkPullClaims("a", boot)).isTrue();
            assertThat(pool.acceptsWorkPullReoffers("a", boot)).isTrue();
            assertThat(pool.acceptsWorkPullClaims("a", "other-boot")).isFalse();
            assertThat(pool.acceptsWorkPullReoffers("a", "other-boot")).isFalse();
            assertThat(pool.acceptsWorkPullClaims("z", boot)).isFalse();
            assertThat(pool.acceptsWorkPullReoffers("z", boot)).isFalse();
            var claimed = new Placement("tenant", "session", "workspace", "a", boot, 3, "ACTIVE");
            assertThat(pool.claimLoad("tenant", "session", claimed)).containsEntry("sessionId", "session");
            var routed = ArgumentCaptor.forClass(QwenHostedHarnessConnector.PoolCall.class);
            verify(leafA).withPlacement(routed.capture(), any());
            assertThat(routed.getValue().placement().getPlacementEpoch()).isEqualTo(3);
            assertThat(routed.getValue().placement().getInstanceId()).isEqualTo("a");
            assertThat(routed.getValue().writerToken()).isNotBlank();
        }
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

    @Test
    void refusesNonStaticPoolDiscovery() {
        var properties = settings();
        properties.getHarness().getPool().setDiscovery("kubernetes");
        assertThatThrownBy(() -> new HarnessPoolConnector(properties, mock(JdbcHarnessPlacementStore.class),
                () -> new HarnessDiscovery.Snapshot(List.of(), true), ignored -> leaf(), null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Harness pool discovery must be static");
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
