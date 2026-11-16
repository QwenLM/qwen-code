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
}
