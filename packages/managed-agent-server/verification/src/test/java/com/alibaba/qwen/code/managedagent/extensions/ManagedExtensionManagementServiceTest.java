/*
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedExtensionManagementServiceTest {
    @Test
    void admittedApplyReplaySkipsSourcePermissionButNewSelectionsDoNot() {
        var json = new ObjectMapper();
        var store = mock(SessionPolicyStore.class);
        var sessions = mock(ManagedAgentService.class);
        var records = mock(ManagedExtensionRecordStore.class);
        var packages = mock(ManagedExtensionPackageService.class);
        var harness = mock(HarnessConnector.class);
        var session = mock(SessionRecord.class);
        var workspace = mock(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding.class);
        when(session.workspace()).thenReturn(workspace);
        when(workspace.getWorkspaceId()).thenReturn("workspace");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(store.requireExtensionManagement(anyString(), anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyBoolean())).thenReturn(session);
        when(harness.supportsSessionExtensions()).thenReturn(true);
        String operation = java.util.UUID.nameUUIDFromBytes("managed-extension-apply\0tenant\0actor\0session\0original"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
        var command = json.createObjectNode().put("expectedConfigRevision", 0);
        command.putArray("extensions").addObject().put("extensionId", "ext_source").put("packageRevision", 1).put("packageDigest", "a".repeat(64));
        var accepted = json.createObjectNode().put("kind", "hosted-extension-config").put("operationId", operation)
                .put("phase", "preparing").put("mode", "apply").put("configRevision", 1).put("previousConfigRevision", 0);
        accepted.putNull("previousRecordRef").putNull("bundleRef").putNull("error");
        var savedCommand = accepted.putObject("command").put("operationId", operation)
                .put("actorKey", org.apache.commons.codec.digest.DigestUtils.sha256Hex("actor")).put("expectedRevision", 0);
        savedCommand.set("extensions", command.get("extensions"));
        when(records.currentMcpSettings("tenant", "session")).thenReturn(accepted);
        org.mockito.Mockito.doThrow(new ManagedAgentException(404, "extension_package_not_found", "revoked"))
                .when(packages).authorizeSelection(anyString(), anyString(), anyString(), any());
        var service = new ManagedExtensionManagementService(store, sessions, records, packages, json, harness);
        assertThat(service.submit("tenant", "actor", "session", "original", command).path("operation").path("operationId").asText()).isEqualTo(operation);
        verify(packages, never()).authorizeSelection(anyString(), anyString(), anyString(), any());
        command.put("expectedConfigRevision", 1);
        assertThatThrownBy(() -> service.submit("tenant", "actor", "session", "original", command))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        assertThatThrownBy(() -> service.submit("tenant", "actor", "session", "new", command))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(404));
        verify(harness, never()).applyExtensions(anyString(), anyString(), any());
    }

    @Test
    void lookupRejectsUnknownKeyWhenSessionHasNoWorkspace() {
        SessionPolicyStore store = mock(SessionPolicyStore.class);
        ManagedAgentService sessions = mock(ManagedAgentService.class);
        SessionRecord session = mock(SessionRecord.class);
        when(sessions.requireReadableSession("tenant", "actor", "legacy")).thenReturn(session);
        when(session.workspace()).thenReturn(null);
        ManagedExtensionManagementService service = new ManagedExtensionManagementService(store, sessions,
                mock(ManagedExtensionRecordStore.class), mock(ManagedExtensionPackageService.class), new ObjectMapper(),
                mock(HarnessConnector.class));

        assertThat(service.query("tenant", "actor", "legacy", null).path("supported").asBoolean()).isFalse();
        assertThatThrownBy(() -> service.lookup("tenant", "actor", "legacy", "never-submitted"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("extension_operation_not_found");
                });
    }

    @Test
    void snapshotReportsActivePackageDegradationWithoutChangingPinShapes() {
        var service = serviceWithActiveBundle(bundleWithDegradation("[\"hooks\"]"));
        var snapshot = service.query("tenant", "actor", "session", null);
        assertThat(snapshot.path("degradedComponents").path("ext_mixed").toString()).isEqualTo("[\"hooks\"]");
        assertThat(snapshot.path("extensions").get(0).path("extensionId").asText()).isEqualTo("ext_mixed");
        assertThat(snapshot.path("extensions").get(0).size()).isEqualTo(3);
        assertThat(snapshot.path("requestedExtensions").get(0).size()).isEqualTo(3);
    }

    @Test
    void snapshotOmitsDegradationWhenNothingDegraded() {
        assertThat(serviceWithActiveBundle(bundleWithDegradation(null))
                .query("tenant", "actor", "session", null).has("degradedComponents")).isFalse();
        assertThat(serviceWithActiveBundle(bundleWithDegradation("[]"))
                .query("tenant", "actor", "session", null).has("degradedComponents")).isFalse();
    }

    @Test
    void snapshotRejectsMalformedDegradationAsCorrupt() {
        for (String malformed : new String[]{"[\"skills\"]", "[\"hooks\",\"hooks\"]", "\"hooks\"", "[\"mcp\",\"hooks\",\"mcp\"]", "null"}) {
            var service = serviceWithActiveBundle(bundleWithDegradation(malformed));
            assertThatThrownBy(() -> service.query("tenant", "actor", "session", null))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_config_corrupt"));
        }
    }

    @Test
    void snapshotNormalizesDegradationToCanonicalOrder() {
        var service = serviceWithActiveBundle(bundleWithDegradation("[\"hooks\",\"mcp\"]"));
        assertThat(service.query("tenant", "actor", "session", null)
                .path("degradedComponents").path("ext_mixed").toString()).isEqualTo("[\"mcp\",\"hooks\"]");
    }

    private ManagedExtensionManagementService serviceWithActiveBundle(String bundleJson) {
        var json = new ObjectMapper();
        var store = mock(SessionPolicyStore.class);
        var sessions = mock(ManagedAgentService.class);
        var records = mock(ManagedExtensionRecordStore.class);
        var packages = mock(ManagedExtensionPackageService.class);
        var harness = mock(HarnessConnector.class);
        var session = mock(SessionRecord.class);
        var workspace = mock(com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding.class);
        when(session.workspace()).thenReturn(workspace);
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(packages.supported()).thenReturn(true);
        when(harness.supportsSessionExtensions()).thenReturn(true);
        var active = json.createObjectNode().put("kind", "hosted-extension-config").put("phase", "active").put("mode", "apply")
                .put("operationId", java.util.UUID.randomUUID().toString()).put("configRevision", 1).put("previousConfigRevision", 0);
        active.putObject("bundleRef").put("resourceId", "bundle-1").put("kind", "managed-extension-config-bundle")
                .put("schemaVersion", 1).put("byteLength", 0).put("digest", "a".repeat(64));
        active.putNull("previousRecordRef").putNull("error");
        when(records.currentMcpSettings("tenant", "session")).thenReturn(active);
        byte[] bytes = bundleJson.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        when(records.readCommittedResource(anyString(), anyString(), any())).thenReturn(
                new com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource(
                        "bundle-1", "managed-extension-config-bundle", 1, bytes.length,
                        org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes), bytes));
        return new ManagedExtensionManagementService(store, sessions, records, packages, json, harness);
    }

    private static String bundleWithDegradation(String degradedJson) {
        return "{\"kind\":\"managed-extension-config-bundle\",\"formatVersion\":1,\"configRevision\":1,\"packages\":[{\"pin\":{\"extensionId\":\"ext_mixed\",\"packageRevision\":1,\"packageDigest\":\""
                + "b".repeat(64) + "\"}" + (degradedJson == null ? "" : ",\"degradedComponents\":" + degradedJson) + "}]}";
    }
}
