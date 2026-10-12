package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.List;

class ManagedToolResultCaptureTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void capturesMultipleReceiptsWithOneLookupAndOneBatchAndRejectsConflicts() throws Exception {
        var jdbc = mock(JdbcTemplate.class);
        var store =
                new ManagedToolResultStore(
                        jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        JsonNode first =
                JSON.readTree(
                        "{\"sequence\":1,\"sessionKey\":{\"tenantId\":\"t\",\"workspaceId\":\"w\",\"sessionId\":\"s\"},\"payload\":{\"executionCallId\":\"call-1\",\"toolOutcomeRef\":null,\"resultRef\":null,\"resources\":[]}}");
        var second = first.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) second).put("sequence", 2);
        ((com.fasterxml.jackson.databind.node.ObjectNode) second.path("payload"))
                .put("executionCallId", "call-2");
        store.captureEvents("t", "w", "s", 1, List.of(first, second));
        verify(jdbc, times(1)).queryForList(anyString(), any(Object[].class));
        verify(jdbc, times(1))
                .batchUpdate(
                        anyString(),
                        org.mockito.ArgumentMatchers.<List<Object[]>>argThat(
                                rows -> rows.size() == 2));
        var changed = first.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) changed).put("sequence", 3);
        clearInvocations(jdbc);
        assertThatThrownBy(() -> store.captureEvents("t", "w", "s", 1, List.of(first, changed)))
                .hasMessageContaining("source changed");
        verifyNoInteractions(jdbc);
    }
}
