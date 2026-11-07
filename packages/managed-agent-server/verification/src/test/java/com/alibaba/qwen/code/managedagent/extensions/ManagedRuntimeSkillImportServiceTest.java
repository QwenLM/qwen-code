package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedRuntimeSkills;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedRuntimeSkillImportServiceTest {
    @ParameterizedTest
    @CsvSource({
        "candidates,409,skill_source_busy", "snapshot,409,source_changed", "archive,409,skill_snapshot_unavailable",
        "candidates,503,skill_source_busy", "snapshot,500,source_changed", "archive,409,INVALID_CODE"
    })
    void mapsHarnessRefusalsWithoutReplaying(String route, int status, String code) {
        var fixture = fixture();
        var failure = new HarnessHttpFailure("private transport details", null, status, "private body", Map.of("code", code));
        refuse(fixture, route, failure);
        boolean preserve = status == 409 && !"INVALID_CODE".equals(code);
        assertThatThrownBy(() -> read(fixture, route))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(preserve ? 409 : 503);
                    assertThat(error.getCode()).isEqualTo(preserve ? code : "runtime_skill_import_unavailable");
                    assertThat(error.getMessage()).doesNotContain("private");
                });
        verify(fixture.harness(), never()).createOrLoad(anyString(), anyString(), anyBoolean());
        verify(fixture.harness(), never()).applyExtensions(anyString(), anyString(), anyMap());
    }

    @ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"candidates", "snapshot", "archive"})
    void mapsUnreachableHarnessWithoutLeakingOrReplaying(String route) {
        var fixture = fixture();
        refuse(fixture, route, new HarnessFailure("private transport details", null));
        assertThatThrownBy(() -> read(fixture, route))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("runtime_skill_import_unavailable");
                    assertThat(error.getMessage()).doesNotContain("private");
                });
        verify(fixture.harness(), never()).createOrLoad(anyString(), anyString(), anyBoolean());
    }

    @Test
    void closeFailuresDeleteDownloadsAndReturnEveryPermit() throws Exception {
        var fixture = fixture();
        var paths = new ArrayList<Path>();
        var closes = new AtomicInteger();
        try (var files = mockStatic(Files.class, CALLS_REAL_METHODS)) {
            files.when(() -> Files.newOutputStream(any(Path.class), any(OpenOption[].class))).thenAnswer(call -> {
                paths.add(call.getArgument(0));
                OutputStream output = (OutputStream) call.callRealMethod();
                return new FilterOutputStream(output) {
                    @Override
                    public void close() throws IOException {
                        super.close();
                        if (closes.getAndIncrement() < 4) {
                            throw new IOException("injected close failure");
                        }
                    }
                };
            });
            for (int attempt = 0; attempt < 4; attempt++) {
                assertThatThrownBy(() -> read(fixture, "snapshot"))
                        .isInstanceOf(IOException.class).hasMessage("injected close failure");
                assertThat(paths).allSatisfy(file -> assertThat(Files.exists(file)).isFalse());
            }
            assertThat(read(fixture, "snapshot").path("inspection").path("fileCount").asInt()).isEqualTo(1);
            assertThat(paths).hasSize(5).allSatisfy(file -> assertThat(Files.exists(file)).isFalse());
        } finally {
            for (Path file : paths) {
                Files.deleteIfExists(file);
            }
        }
    }

    private record Fixture(ManagedRuntimeSkillImportService service, HarnessConnector harness,
            ManagedRuntimeSkills.SnapshotRequest request) { }

    private static Fixture fixture() {
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
            return Map.of("sessionId", "session", "owner", ownerMap, "operationId", request.get("operationId"),
                    "preparationId", preparation, "offset", 0, "totalBytes", bytes.length, "base64", Base64.getEncoder().encodeToString(bytes));
        });
        var json = new ObjectMapper();
        when(packages.preview(eq("tenant"), eq("actor"), eq("workspace"), anyString(), any(InputStream.class), eq((long) bytes.length)))
                .thenReturn(json.createObjectNode().put("fileCount", 1));
        return new Fixture(new ManagedRuntimeSkillImportService(packages, policy, harness, json), harness,
                new ManagedRuntimeSkills.SnapshotRequest(owner, ".qwen/skills/check", "a".repeat(64),
                        new ManagedExtensionPackages.Target("linux", "any")));
    }

    private static com.fasterxml.jackson.databind.JsonNode read(Fixture fixture, String route) throws IOException {
        return "candidates".equals(route) ? fixture.service().candidates("tenant", "actor", "session")
                : fixture.service().snapshot("tenant", "actor", "session", fixture.request());
    }

    private static void refuse(Fixture fixture, String route, HarnessFailure failure) {
        switch (route) {
            case "candidates" -> doThrow(failure).when(fixture.harness()).runtimeSkillCandidates("tenant", "session");
            case "snapshot" -> doThrow(failure).when(fixture.harness()).runtimeSkillSnapshot(eq("tenant"), eq("session"), anyMap());
            case "archive" -> doThrow(failure).when(fixture.harness()).runtimeSkillArchive(eq("tenant"), eq("session"), anyMap());
            default -> throw new IllegalArgumentException(route);
        }
    }

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
