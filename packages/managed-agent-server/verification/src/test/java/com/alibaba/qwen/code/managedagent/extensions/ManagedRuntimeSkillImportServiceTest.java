package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedRuntimeSkills;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.Base64;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedRuntimeSkillImportServiceTest {
    @Test
    void snapshotDownloadsExactOwnerBytesAndPreviewsWithoutPublishingOrApplying() throws Exception {
        var packages = mock(ManagedExtensionPackageService.class);
        var policy = mock(SessionPolicyStore.class);
        var harness = mock(HarnessConnector.class);
        var session = mock(SessionRecord.class);
        var binding = mock(ContextBinding.class);
        when(session.workspace()).thenReturn(binding);
        when(binding.getWorkspaceId()).thenReturn("workspace");
        when(session.toolProfile()).thenReturn("hosted-workspace-shell/1");
        when(policy.requireExtensionManagement("tenant", "actor", "session", null, true)).thenReturn(session);
        when(packages.runtimeSkillImportEnabled()).thenReturn(true);
        when(harness.supportsRuntimeSkillImport()).thenReturn(true);
        byte[] bytes = "immutable Skill source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String digest = DigestUtils.sha256Hex(bytes);
        var owner = new ManagedRuntimeSkills.Owner("binding", "1");
        var ownerMap = Map.of("bindingId", "binding", "generation", "1");
        String preparation = "550e8400-e29b-41d4-a716-446655440000";
        when(harness.runtimeSkillSnapshot(eq("tenant"), eq("session"), anyMap())).thenAnswer(call -> {
            Map<?, ?> request = call.getArgument(2);
            return Map.of("sessionId", "session", "owner", ownerMap, "operationId", request.get("operationId"),
                    "preparationId", preparation, "sourceDigest", digest, "byteLength", bytes.length);
        });
        when(harness.runtimeSkillArchive(eq("tenant"), eq("session"), anyMap())).thenAnswer(call -> {
            Map<?, ?> request = call.getArgument(2);
            assertThat(request.get("owner")).isEqualTo(ownerMap);
            assertThat(request.get("offset")).isEqualTo(0L);
            return Map.of("sessionId", "session", "owner", ownerMap, "operationId", request.get("operationId"),
                    "preparationId", preparation, "offset", 0, "totalBytes", bytes.length, "base64", Base64.getEncoder().encodeToString(bytes));
        });
        var json = new ObjectMapper();
        var inspection = json.createObjectNode().put("fileCount", 1);
        when(packages.preview(eq("tenant"), eq("actor"), eq("workspace"), anyString(), any(InputStream.class), eq((long) bytes.length)))
                .thenAnswer(call -> {
                    InputStream input = call.getArgument(4);
                    assertThat(input.readAllBytes()).isEqualTo(bytes);
                    return inspection;
                });
        var service = new ManagedRuntimeSkillImportService(packages, policy, harness, json);
        var target = new ManagedExtensionPackages.Target("linux", "any");
        var result = service.snapshot("tenant", "actor", "session", new ManagedRuntimeSkills.SnapshotRequest(owner,
                ".qwen/skills/check", "a".repeat(64), target));
        assertThat(result.path("inspection")).isEqualTo(inspection);
        assertThat(result.path("sourceDigest").asText()).isEqualTo(digest);
        verify(harness, never()).applyExtensions(anyString(), anyString(), anyMap());
        verify(harness, never()).createOrLoad(anyString(), anyString(), anyBoolean());
    }

    @Test
    void rejectsUnsupportedSessionBeforeQueryingAnyRuntime() {
        var policy = mock(SessionPolicyStore.class);
        var packages = mock(ManagedExtensionPackageService.class);
        var harness = mock(HarnessConnector.class);
        var session = mock(SessionRecord.class);
        when(policy.requireExtensionManagement("tenant", "actor", "session", null, true)).thenReturn(session);
        var service = new ManagedRuntimeSkillImportService(packages, policy, harness, new ObjectMapper());
        assertThatThrownBy(() -> service.candidates("tenant", "actor", "session"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("unsupported_feature"));
        verify(harness, never()).runtimeSkillCandidates(anyString(), anyString());
    }
}
