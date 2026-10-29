package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionLineage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.RETURNS_SELF;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HarnessConfigurationTest {
    @Test
    void standaloneConnectorPublishesSkillsAndInheritedExtensions() throws Exception {
        String sessionId = "33333333-3333-4333-8333-333333333333";
        String parentId = "22222222-2222-4222-8222-222222222222";
        String bootId = "11111111-1111-4111-8111-111111111111";
        var properties = new ManagedAgentProperties();
        properties.getHarness().setToken("test-harness-token");
        properties.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("https://store.example");
        properties.getSessionStore().setWorkspaceId("workspace");
        var sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant", sessionId)).thenReturn(new SessionRecord(
                "tenant", sessionId, "qwen-code", null, null, "ACTIVE", null, null,
                0, 0, 0, 1, 1, null, 1, new ContextBinding("tenant", "workspace", 1,
                        "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1),
                "default", "hosted-workspace-shell/1", null, 1));
        when(sessions.findChildLineage("tenant", sessionId))
                .thenReturn(new SessionLineage(parentId, parentId, "child-run", 1));
        var actions = mock(ManagedActionStore.class);
        when(actions.approvalMode("tenant", sessionId)).thenReturn("default");
        var skills = mock(ManagedSessionSkills.class);
        when(skills.snapshot("tenant", sessionId)).thenReturn(List.of());
        var extensions = mock(ManagedExtensionRecordStore.class);
        var resources = mock(ManagedSessionStore.class);
        var json = new ObjectMapper();
        var run = json.readTree("{\"inputRef\":{\"resourceId\":\"launch\"}}");
        var launch = json.readTree("""
                {"publicLaunch":{"version":2,
                  "modelRoute":{"authType":"api-key","endpointDigest":"endpoint","providerPin":"provider"},
                  "extensionAgent":{"bundleRef":{"resourceId":"bundle"}}}}
                """);
        var extensionAgent = launch.path("publicLaunch").path("extensionAgent");
        var bundleRef = extensionAgent.path("bundleRef");
        var bundle = mock(StoredResource.class);
        when(extensions.findRecord("tenant", parentId, "child_run", "child-run")).thenReturn(Optional.of(run));
        when(extensions.readRecordResource("tenant", parentId, run.path("inputRef"))).thenReturn(launch);
        when(extensions.readRecordResource("tenant", parentId, bundleRef)).thenReturn(json.readTree("{\"packages\":[]}"));
        when(extensions.readCommittedResource("tenant", parentId, bundleRef)).thenReturn(bundle);
        when(resources.publishInheritedExtensionResource("tenant", "workspace", sessionId, bundle))
                .thenReturn(new ToolResultResourceRef("copied-bundle", "extension-bundle", 1, 2, "digest"));
        var client = mock(HostedHarnessClient.class);
        var capabilities = mock(HostedHarnessCapabilities.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(bootId);
        when(capabilities.getFeatures()).thenReturn(List.of("public-child-agents/1", "approval-selection/1", "session-skills/2"));
        when(capabilities.getLifecycleV2Profiles()).thenReturn(List.of("hosted-workspace-shell/1"));
        var attached = mock(HarnessSessionRef.class);
        when(attached.getHarnessBootId()).thenReturn(bootId);
        when(attached.getApprovalMode()).thenReturn("default");
        when(client.createSession(any())).thenReturn(attached);
        var builder = mock(HostedHarnessClient.Builder.class, RETURNS_SELF);
        when(builder.build()).thenReturn(client);
        try (var sdk = mockStatic(HostedHarnessClient.class, CALLS_REAL_METHODS)) {
            sdk.when(HostedHarnessClient::builder).thenReturn(builder);
            try (var connector = new HarnessConfiguration().hostedHarnessConnector(properties,
                    sessions, mock(WorkspaceExecutionStore.class), actions, mock(ManagedAgentDefinitionStore.class),
                    resources, mock(SshWorkspaceStore.class), mock(HarnessPlacementStore.class), skills, json, extensions)) {
                assertThat(connector.createOrLoad("tenant", sessionId, false).bootId()).isEqualTo(bootId);
                var request = ArgumentCaptor.forClass(CreateHarnessSession.class);
                verify(client).createSession(request.capture());
                Map<String, Object> wire = ReflectionTestUtils.invokeMethod(request.getValue(), "toJson");
                assertThat(wire).containsEntry("sessionId", sessionId).containsKey("sessionSkillsRef");
                assertThat(wire.get("publicChildExtensionAgent")).isEqualTo(Map.of(
                        "extensionAgent", Map.of("bundleRef", Map.of("resourceId", "bundle")),
                        "effectiveConfigRef", Map.of("resourceId", "copied-bundle", "kind", "extension-bundle",
                                "schemaVersion", 1, "byteLength", 2L, "digest", "digest")));
                verify(resources).publishAgentSkills("tenant", "workspace", sessionId, List.of());
                verify(resources).publishInheritedExtensionResource("tenant", "workspace", sessionId, bundle);
            }
        }
    }
}
