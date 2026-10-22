package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.ApiModels.ManagedMcpManagementCommand;
import com.alibaba.qwen.code.managedagent.model.ApiModels.ManagedMcpServerPin;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedMcpManagementServiceTest {
    private final AgentStateStore store = mock(AgentStateStore.class);
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final ManagedMcpManagementService service = new ManagedMcpManagementService(sessions, store, harness, new ObjectMapper());
    private final SessionRecord session = mock(SessionRecord.class);

    @BeforeEach
    void setUp() {
        when(session.toolProfile()).thenReturn("hosted-workspace-shell/1");
        when(store.requireMcpManagement(eq("tenant"), anyString(), eq("session"), any())).thenReturn(session);
        when(harness.supportsMcpManagement()).thenReturn(true);
        when(harness.supportsLifecycle("hosted-workspace-shell/1")).thenReturn(true);
        when(harness.manageMcp(eq("tenant"), eq("session"), any())).thenReturn(snapshot());
    }

    @Test
    void keysOneCommandByActorSessionAndIdempotencyKeyWithoutCopyingRecipes() {
        var command = new ManagedMcpManagementCommand("add", "docs", 0L,
                new ManagedMcpServerPin("docs", 2, "a".repeat(64)));
        service.submit("tenant", "actor", "session", "key", command);
        service.submit("tenant", "actor", "session", "key", command);
        service.submit("tenant", "second", "session", "key", command);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> requests = ArgumentCaptor.forClass(Map.class);
        verify(harness, org.mockito.Mockito.times(3)).manageMcp(eq("tenant"), eq("session"), requests.capture());
        var values = requests.getAllValues();
        assertThat(values.get(0)).isEqualTo(values.get(1));
        assertThat(values.get(2).get("operationId")).isNotEqualTo(values.get(0).get("operationId"));
        assertThat(values.get(0)).containsOnlyKeys("operationId", "actorKey", "action", "serverId", "expectedRevision", "server");
        assertThat(((Map<?, ?>) values.get(0).get("server")).keySet()).isEqualTo(Set.of("serverId", "serverRevision", "definitionDigest"));
    }

    @Test
    void oldHarnessAnswersUnsupportedWithoutCreatingOrLoadingASession() {
        when(harness.supportsMcpManagement()).thenReturn(false);
        assertThat(service.get("tenant", "actor", "session").path("supported").asBoolean()).isFalse();
        verify(harness, never()).mcpManagement(anyString(), anyString());
        assertThatThrownBy(() -> service.submit("tenant", "actor", "session", "key",
                new ManagedMcpManagementCommand("restart", "docs", 0L, null)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("unsupported_feature"));
    }

    @Test
    void operatorAdmissionPrecedesInventoryAndAStatusReadNeverSubmits() {
        when(store.requireMcpManagement("tenant", "reader", "session", null)).thenThrow(
                new ManagedAgentException(HttpStatus.FORBIDDEN, "session_operation_forbidden", "Forbidden"));
        assertThatThrownBy(() -> service.get("tenant", "reader", "session")).isInstanceOf(ManagedAgentException.class);
        verify(harness, never()).mcpManagement(anyString(), anyString());
        String operation = "11111111-1111-4111-8111-111111111111";
        when(harness.mcpManagementOperation("tenant", "session", operation)).thenReturn(snapshot());
        assertThat(service.operation("tenant", "actor", "session", operation).path("sessionId").asText()).isEqualTo("session");
        verify(harness, never()).manageMcp(anyString(), anyString(), any());
    }

    @Test
    void reportsTheRequiredExplicitLoadWithoutRetryingTheOriginalOperation() {
        var refusal = mock(DaemonHttpException.class);
        when(refusal.getStatusCode()).thenReturn(409);
        when(refusal.getErrorCode()).thenReturn("hosted_mcp_session_load_required");
        when(harness.mcpManagement("tenant", "session")).thenThrow(refusal);
        assertThatThrownBy(() -> service.get("tenant", "actor", "session"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo("hosted_mcp_session_load_required");
                    assertThat(error.getMessage()).isEqualTo("Continue or recover the Session before managing MCP servers.");
                });
        verify(harness).mcpManagement("tenant", "session");
        verify(harness, never()).createOrLoad(anyString(), anyString(), anyBoolean());
        verify(harness, never()).manageMcp(anyString(), anyString(), any());
    }

    private static Map<String, Object> snapshot() {
        return Map.of("sessionId", "session", "revision", 0, "supported", true,
                "servers", List.of(), "availableServers", List.of());
    }
}
