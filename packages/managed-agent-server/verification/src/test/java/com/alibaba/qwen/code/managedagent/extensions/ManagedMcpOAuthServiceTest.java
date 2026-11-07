package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.config.ManagedMcpOAuthProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Attempt;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Credential;
import com.alibaba.qwen.code.managedagent.repository.McpOAuthRepository.Scope;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedMcpOAuthServiceTest {
    private final ObjectMapper json = new ObjectMapper();
    private final Scope scope = new Scope("tenant", "workspace", "actor");
    private final Pin pin = new Pin("ext_fixture", 1, "a".repeat(64), null);
    private final ManagedMcpOAuthProperties settings = new ManagedMcpOAuthProperties();
    private final McpOAuthRepository repository = mock(McpOAuthRepository.class);
    private final ManagedExtensionPackageService packages = mock(ManagedExtensionPackageService.class);
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedMcpOAuthClient client = mock(ManagedMcpOAuthClient.class);
    private final AgentStateStore stateStore = mock(AgentStateStore.class);
    private ManagedMcpOAuthService service;

    @BeforeEach
    void setup() {
        var session = mock(SessionRecord.class);
        var workspace = mock(ContextBinding.class);
        when(session.tenantId()).thenReturn("tenant");
        when(session.sessionId()).thenReturn("session");
        when(session.workspace()).thenReturn(workspace);
        when(session.toolProfile()).thenReturn("hosted-workspace-mcp/1");
        when(workspace.getWorkspaceId()).thenReturn("workspace");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(packages.canPublish("tenant", "actor", "workspace")).thenReturn(true);
        service = new ManagedMcpOAuthService(settings, repository, packages,
                mock(ManagedExtensionRecordStore.class), sessions, client, json, stateStore);
    }

    @Test
    void disabledOAuthKeepsOwnedGrantQueriesAndRevocationButRejectsNewAuthorizationAndTokens() {
        ObjectNode binding = binding();
        String credentialId = McpOAuthRepository.credentialId(scope, binding);
        var grant = new Credential(credentialId, scope, binding, 8, "active", Long.MAX_VALUE,
                json.createObjectNode().put("access_token", "private"), null, null);
        String attemptId = "mauth_" + UUID.randomUUID();
        var attempt = new Attempt(attemptId, scope, "state", "nonce", "digest", "completed", 0,
                binding.deepCopy().put("credentialEpoch", 7), json.createObjectNode(), credentialId);
        when(repository.credentials(scope)).thenReturn(List.of(grant));
        when(repository.attempt(scope, attemptId)).thenReturn(attempt);
        when(repository.credential(scope, credentialId)).thenReturn(grant);
        when(repository.revoke(scope, credentialId, 8)).thenReturn(new Credential(credentialId, scope,
                binding, 9, "revoked", 0, json.createObjectNode(), null, null));

        var query = service.query("tenant", "actor", "session", null);
        assertThat(query.path("supported").asBoolean()).isFalse();
        assertThat(query.path("canAuthorize").asBoolean()).isFalse();
        assertThat(query.path("servers").get(0).path("credentialId").asText()).isEqualTo(credentialId);
        assertThat(query.toString()).doesNotContain("private");
        assertThat(service.status("tenant", "actor", "session", attemptId).path("generation").asLong()).isEqualTo(8);
        assertThat(service.revoke("tenant", "actor", "session", credentialId, 8).path("generation").asLong()).isEqualTo(9);
        assertThatThrownBy(() -> service.start("tenant", "actor", "session", "ext_fixture:server", pin, "n".repeat(43), "start"))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.complete("tenant", "actor", "session", attemptId, "n".repeat(43)))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.accessToken("tenant", "actor", "session", "ext_fixture:server", credentialId, 8, "https://mcp.example/mcp"))
                .isInstanceOf(ManagedAgentException.class);
        verify(repository, never()).createAttempt(any());
        verify(repository, never()).claimAttempt(any(), anyString(), anyString(), anyLong());
        verify(client, never()).refresh(any(), anyString());
    }

    @Test
    void disabledManagementStillChecksTheCurrentWorkspacePermission() {
        String attemptId = "mauth_" + UUID.randomUUID();
        String credentialId = "mcred_" + UUID.randomUUID();
        when(packages.canPublish("tenant", "actor", "workspace")).thenReturn(false);
        doThrow(new ManagedAgentException(403, "forbidden", "Forbidden"))
                .when(packages).requireExecutionAccess("tenant", "actor", "workspace");
        assertThatThrownBy(() -> service.query("tenant", "actor", "session", null))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(403));
        assertThatThrownBy(() -> service.status("tenant", "actor", "session", attemptId)).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.revoke("tenant", "actor", "session", credentialId, 1)).isInstanceOf(ManagedAgentException.class);
        verify(repository, never()).credentials(any());
        verify(repository, never()).revoke(any(), anyString(), anyLong());
    }

    @Test
    void emptyBindingRepairNeedsTheV2WorkerCapabilityWhileOAuthIsDisabled() {
        var policy = mock(SessionPolicyStore.class);
        var records = mock(ManagedExtensionRecordStore.class);
        var harness = mock(HarnessConnector.class);
        when(harness.supportsSessionExtensions()).thenReturn(true);
        var session = sessions.requireReadableSession("tenant", "actor", "session");
        when(policy.requireExtensionManagement(eq("tenant"), eq("actor"), eq("session"), anyString(), eq(true)))
                .thenReturn(session);
        var management = new ManagedExtensionManagementService(policy, sessions, records, packages, json, harness);
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("oauth", service);
        ReflectionTestUtils.setField(management, "oauth", beans.getBeanProvider(ManagedMcpOAuthService.class));
        ObjectNode command = json.createObjectNode().put("selectionVersion", 2).put("expectedConfigRevision", 0);
        command.putArray("extensions");
        command.putArray("mcpAuthBindings");
        assertThatThrownBy(() -> management.submit("tenant", "actor", "session", "repair", command))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("unsupported_feature"));
        verify(harness, never()).applyExtensions(anyString(), anyString(), anyMap());

        when(harness.supportsPersonalMcpOAuth()).thenReturn(true);
        when(harness.applyExtensions(eq("tenant"), eq("session"), anyMap())).thenAnswer(call -> {
            Map<String, Object> request = call.getArgument(2);
            assertThat(request.get("mcpAuthBindings")).isEqualTo(List.of());
            return Map.of("sessionId", "session", "operation", Map.of("operationId", request.get("operationId")));
        });
        assertThat(management.submit("tenant", "actor", "session", "repair", command).path("sessionId").asText())
                .isEqualTo("session");
    }

    @Test
    void reauthorizationReadsTheExactStableCredentialInsteadOfTheBoundedCredentialList() throws Exception {
        var provider = enableOAuth();
        when(client.providerDigest(provider)).thenReturn("b".repeat(64));
        ObjectNode recipe = json.createObjectNode().put("httpUrl", provider.getResourceUri());
        recipe.putObject("auth").put("type", "oauth").put("providerId", "provider")
                .put("resourceUri", provider.getResourceUri()).putArray("scopes").add("read");
        ObjectNode inspection = json.createObjectNode();
        inspection.putArray("mcpServers").addObject().put("name", "server").set("recipe", recipe);
        when(packages.inspection("tenant", "actor", "workspace", pin)).thenReturn(inspection);
        ObjectNode binding = binding();
        String credentialId = McpOAuthRepository.credentialId(scope, binding);
        when(repository.credential(scope, credentialId)).thenReturn(new Credential(credentialId, scope,
                binding, 513, "revoked", 0, json.createObjectNode(), null, null));
        when(repository.createAttempt(any())).thenAnswer(call -> call.getArgument(0));

        service.start("tenant", "actor", "session", "ext_fixture:server", pin, "n".repeat(43), "start");

        var captured = ArgumentCaptor.forClass(Attempt.class);
        verify(repository).createAttempt(captured.capture());
        assertThat(captured.getValue().binding().path("credentialEpoch").asLong()).isEqualTo(513);
        verify(repository, never()).credentials(any());
    }

    @Test
    void supportedQueryRejectsReadersBeforeInspectionAndAllowsPublishers() throws Exception {
        enableOAuth();
        var session = sessions.requireReadableSession("tenant", "actor", "session");
        when(sessions.requireReadableSession("tenant", "reader", "session")).thenReturn(session);
        doThrow(new ManagedAgentException(403, "extension_management_forbidden", "Forbidden"))
                .when(packages).requireExecutionAccess("tenant", "reader", "workspace");
        assertThatThrownBy(() -> service.query("tenant", "reader", "session", List.of(pin)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getStatus()).isEqualTo(403));
        verify(packages, never()).inspection(eq("tenant"), eq("reader"), eq("workspace"), any(Pin.class));
        verify(repository, never()).credentials(any());

        when(repository.credentials(scope)).thenReturn(List.of());
        ObjectNode inspection = json.createObjectNode();
        inspection.putArray("mcpServers");
        when(packages.inspection("tenant", "actor", "workspace", pin)).thenReturn(inspection);
        var result = service.query("tenant", "actor", "session", List.of(pin));
        assertThat(result.path("supported").asBoolean()).isTrue();
        assertThat(result.path("canAuthorize").asBoolean()).isTrue();
        assertThat(result.path("servers").isEmpty()).isTrue();
        verify(packages).requireExecutionAccess("tenant", "actor", "workspace");
    }

    @Test
    void malformedPinsAreRejectedBeforeInspectionOrAuthorization() throws Exception {
        enableOAuth();
        var malformed = new Pin(null, 1, "a".repeat(64), null);
        assertThatThrownBy(() -> service.start("tenant", "actor", "session", "ext_fixture:server",
                malformed, "n".repeat(43), "start"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(400);
                    assertThat(error.getCode()).isEqualTo("invalid_mcp_oauth_request");
                });
        for (Pin value : java.util.Arrays.asList(null, malformed)) {
            assertThatThrownBy(() -> service.query("tenant", "actor", "session", java.util.Collections.singletonList(value)))
                    .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(400);
                        assertThat(error.getCode()).isEqualTo("invalid_mcp_oauth_request");
                    });
        }
        verify(packages, never()).inspection(anyString(), anyString(), anyString(), any());
        verify(client, never()).verifyMetadata(any());
    }

    private ManagedMcpOAuthProperties.OAuthProvider enableOAuth() {
        settings.setEnabled(true);
        settings.setCallbackUri("https://agent.example/oauth/mcp/callback");
        settings.setRuntimeTokenProxyBaseUrl("https://broker.example");
        settings.setIsolatedToolProfiles(List.of("hosted-workspace-mcp/1"));
        var provider = new ManagedMcpOAuthProperties.OAuthProvider();
        provider.setIssuer("https://issuer.example");
        provider.setResourceUri("https://mcp.example/mcp");
        provider.setClientId("client");
        provider.setAuthorizationEndpoint("https://issuer.example/authorize");
        provider.setScopes(List.of("read"));
        settings.setProviders(Map.of("provider", provider));
        when(stateStore.supportsPersonalMcpExecution()).thenReturn(true);
        var harness = mock(HarnessConnector.class);
        when(harness.supportsPersonalMcpOAuth()).thenReturn(true);
        var beans = new DefaultListableBeanFactory();
        beans.registerSingleton("harness", harness);
        ReflectionTestUtils.setField(service, "harness", beans.getBeanProvider(HarnessConnector.class));
        return provider;
    }

    private ObjectNode binding() {
        ObjectNode binding = json.createObjectNode().put("serverId", "ext_fixture:server")
                .put("providerId", "provider").put("resourceUri", "https://mcp.example/mcp")
                .put("issuer", "https://issuer.example").put("providerDigest", "b".repeat(64));
        binding.set("pin", json.valueToTree(pin));
        binding.putArray("scopes").add("read");
        return binding;
    }
}
