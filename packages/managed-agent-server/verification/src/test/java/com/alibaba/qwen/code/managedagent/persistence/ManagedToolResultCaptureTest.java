package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class ManagedToolResultCaptureTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void capturesMultipleReceiptsWithOneLookupAndOneBatchAndRejectsConflicts() throws Exception {
        var jdbc = mock(JdbcTemplate.class);
        doReturn(1_000L).when(jdbc).queryForObject(anyString(), any(RowMapper.class));
        var store =
                new JdbcManagedToolResultStore(
                        jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        JsonNode first =
                JSON.readTree(
                        "{\"sequence\":1,\"sessionKey\":{\"tenantId\":\"t\",\"workspaceId\":\"w\",\"sessionId\":\"s\"},\"payload\":{\"executionCallId\":\"call-1\",\"toolOutcomeRef\":null,\"resultRef\":null,\"resources\":[]}}");
        var second = first.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) second).put("sequence", 2);
        ((com.fasterxml.jackson.databind.node.ObjectNode) second.path("payload"))
                .put("executionCallId", "call-2");
        store.captureEvents("t", "w", "s", 1, List.of(first, second));
        verify(jdbc, times(1)).query(anyString(), any(RowMapper.class), any(Object[].class));
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

    @Test
    void workspaceArtifactFirstPageUsesOneFilteredQueryAndTheFirstRowWatermark() throws Exception {
        var jdbc = mock(JdbcTemplate.class);
        var store = new JdbcManagedToolResultStore(
                jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        byte[] actorKey = "actor".getBytes(StandardCharsets.UTF_8);
        stubWorkspaceRows(jdbc, 42, 40, 38);

        var page = store.listWorkspaceArtifacts("t", actorKey, "w", null, null, 2);

        assertThat(page.watermark()).isEqualTo(42);
        assertThat(page.lastId()).isEqualTo(40);
        assertThat(page.hasMore()).isTrue();
        assertThat(page.artifacts()).extracting(a -> a.descriptor().path("id").asText())
                .containsExactly("artifact-42", "artifact-40");
        var sql = ArgumentCaptor.forClass(String.class);
        var args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).query(sql.capture(), any(RowMapper.class), args.capture());
        verifyNoMoreInteractions(jdbc);
        assertThat(sql.getValue()).contains(
                "FROM ma_artifact a JOIN ma_operation r ON r.operation_kind = 'TOOL_RESULT_PROJECTION'",
                "AND r.operation_id = a.result_id JOIN ma_session s ON s.tenant_id = r.tenant_id",
                "AND s.session_id = r.session_id WHERE r.tenant_id = ? AND r.workspace_id = ?",
                "AND s.workspace_id = ? AND r.state = 'READY' AND s.session_kind = 'PUBLIC'",
                "AND s.status NOT IN ('DELETED', 'DELETING')",
                "AND (s.owner_only = 0 OR COALESCE(s.owner_actor_key, s.creator_actor_key) = ?)")
                .endsWith(" ORDER BY a.id DESC LIMIT ?")
                .doesNotContain("MAX(", "a.id <= ?", "a.id < ?");
        assertThat(args.getValue()).containsExactly("t", "w", "w", actorKey, 3);
    }

    @Test
    void workspaceArtifactContinuationKeepsBothIdBoundsAndTheOriginalWatermark() throws Exception {
        var jdbc = mock(JdbcTemplate.class);
        var store = new JdbcManagedToolResultStore(
                jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        byte[] actorKey = "actor".getBytes(StandardCharsets.UTF_8);
        stubWorkspaceRows(jdbc, 38, 36);

        var page = store.listWorkspaceArtifacts("t", actorKey, "w", 42L, 40L, 2);

        assertThat(page.watermark()).isEqualTo(42);
        assertThat(page.lastId()).isEqualTo(36);
        assertThat(page.hasMore()).isFalse();
        assertThat(page.artifacts()).extracting(a -> a.descriptor().path("id").asText())
                .containsExactly("artifact-38", "artifact-36");
        var sql = ArgumentCaptor.forClass(String.class);
        var args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).query(sql.capture(), any(RowMapper.class), args.capture());
        verifyNoMoreInteractions(jdbc);
        assertThat(sql.getValue()).endsWith(" AND a.id <= ? AND a.id < ? ORDER BY a.id DESC LIMIT ?");
        assertThat(args.getValue()).containsExactly("t", "w", "w", actorKey, 42L, 40L, 3);
    }

    @Test
    void emptyWorkspaceArtifactPagesKeepZeroOrSuppliedWatermarks() {
        var jdbc = mock(JdbcTemplate.class);
        var store = new JdbcManagedToolResultStore(
                jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        byte[] actorKey = "actor".getBytes(StandardCharsets.UTF_8);
        for (Long watermark : new Long[] {null, 42L}) {
            var page = store.listWorkspaceArtifacts("t", actorKey, "w", watermark, watermark, 2);
            assertThat(page.artifacts()).isEmpty();
            assertThat(page.watermark()).isEqualTo(watermark == null ? 0 : watermark);
            assertThat(page.lastId()).isZero();
            assertThat(page.hasMore()).isFalse();
            verify(jdbc).query(anyString(), any(RowMapper.class), any(Object[].class));
            verifyNoMoreInteractions(jdbc);
            clearInvocations(jdbc);
        }
    }

    @Test
    void rejectsInvalidWorkspaceArtifactPagesBeforeQuerying() {
        var jdbc = mock(JdbcTemplate.class);
        var store = new JdbcManagedToolResultStore(
                jdbc, mock(PlatformTransactionManager.class), mock(AgentStateStore.class));
        byte[] actorKey = "actor".getBytes(StandardCharsets.UTF_8);
        for (int limit : new int[] {0, 101}) {
            assertThatThrownBy(() -> store.listWorkspaceArtifacts("t", actorKey, "w", null, null, limit))
                    .hasMessage("Invalid workspace artifact page");
        }
        assertThatThrownBy(() -> store.listWorkspaceArtifacts("t", actorKey, "w", null, 1L, 1))
                .hasMessage("Invalid workspace artifact page");
        assertThatThrownBy(() -> store.listWorkspaceArtifacts("t", actorKey, "w", 1L, null, 1))
                .hasMessage("Invalid workspace artifact page");
        assertThatThrownBy(() -> store.listWorkspaceArtifacts("t", actorKey, "w", -1L, 0L, 1))
                .hasMessage("Invalid workspace artifact watermark");
        verifyNoInteractions(jdbc);
    }

    private static void stubWorkspaceRows(JdbcTemplate jdbc, long... ids) {
        doAnswer(invocation -> {
            RowMapper<?> mapper = invocation.getArgument(1);
            var rows = new ArrayList<>();
            for (long id : ids) {
                var row = mock(ResultSet.class);
                when(row.getLong("id")).thenReturn(id);
                when(row.getString("descriptor_json")).thenReturn("{\"id\":\"artifact-" + id + "\"}");
                when(row.getString("request_json")).thenReturn(
                        "{\"tenantId\":\"t\",\"workspaceId\":\"w\",\"sessionId\":\"s\"}");
                when(row.getString("binding_json")).thenReturn("{}");
                when(row.getString("manifest_ref_json")).thenReturn("{}");
                rows.add(mapper.mapRow(row, rows.size()));
            }
            return rows;
        }).when(jdbc).query(anyString(), any(RowMapper.class), any(Object[].class));
    }
}
