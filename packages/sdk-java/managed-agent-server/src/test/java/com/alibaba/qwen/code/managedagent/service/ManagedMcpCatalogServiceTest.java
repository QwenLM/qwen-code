package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class ManagedMcpCatalogServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final ManagedMcpCatalogService service = new ManagedMcpCatalogService(sessions, records);

    @Test
    void publishesOnlyDisplayFieldsFromTheLatestConfigurationAndMarksReleasedCatalogsStale() throws Exception {
        ObjectNode old = configuration("old", "active").put("configRevision", 8);
        ObjectNode current = configuration("current", "released");
        when(records.listRecords("tenant", "session", "mcp_configuration")).thenReturn(List.of(old, current));
        when(records.readRecordResource("tenant", "session", current.get("catalogRef"))).thenReturn(JSON.readTree("""
                {"serverId":"server","configRevision":9,"connectionGeneration":7,"catalogRevision":3,
                 "headers":{"Authorization":"secret"},"env":{"TOKEN":"secret"},"endpoint":"https://secret.invalid",
                 "tools":[{"name":"read","description":"Read","inputSchema":{"type":"object"},"internal":"secret"}],
                 "resources":[{"name":"note","uri":"note:1","mimeType":"text/plain","credentials":"secret"}],
                 "prompts":[{"name":"greet","arguments":[{"name":"who","required":true,"internal":"secret"}]}],
                 "discovery":{"tools":"complete","resources":"failed","prompts":"partial"}}
                """));
        assertThat(service.get("tenant", "actor", "session")).isEqualTo(JSON.readTree("""
                {"object":"agent.mcp_catalog","session_id":"session","servers":[{"server_id":"server","server_revision":9,"catalog_revision":3,
                 "tools":[{"name":"read","description":"Read","input_schema":{"type":"object"}}],
                 "resources":[{"name":"note","uri":"note:1","mime_type":"text/plain"}],
                 "prompts":[{"name":"greet","arguments":[{"name":"who","required":true}]}],
                 "discovery":{"tools":"stale","resources":"stale","prompts":"stale"}}]}
                """));
        current.put("releaseState", "active");
        assertThat(service.get("tenant", "actor", "session").at("/servers/0/discovery"))
                .isEqualTo(JSON.readTree("{\"tools\":\"complete\",\"resources\":\"failed\",\"prompts\":\"partial\"}"));
    }

    @Test
    void doesNotClaimUnpublishedCatalogsAreComplete() {
        ObjectNode pending = configuration("pending", "active");
        pending.putNull("catalogRef");
        pending.putNull("catalogRevision");
        when(records.listRecords("tenant", "session", "mcp_configuration")).thenReturn(List.of(pending));
        var result = service.get("tenant", "actor", "session");
        assertThat(result.at("/servers/0/tools")).isEmpty();
        assertThat(result.at("/servers/0/discovery/tools").asText()).isEqualTo("stale");
        assertThat(result.at("/servers/0/catalog_revision").isNull()).isTrue();
    }

    @Test
    void selectsPublishedCatalogByRevisionEvenWhenRowsAreReversed() throws Exception {
        ObjectNode latest = configuration("latest", "active").put("configRevision", 9);
        ObjectNode oldest = configuration("oldest", "active").put("configRevision", 1);
        ObjectNode failed = configuration("failed", "active").put("configRevision", 10);
        failed.putNull("catalogRef");
        failed.putNull("catalogRevision");
        ObjectNode pending = configuration("pending", "active").put("configRevision", 11);
        pending.putNull("catalogRef");
        pending.putNull("catalogRevision");
        when(records.listRecords("tenant", "session", "mcp_configuration"))
                .thenReturn(List.of(latest, failed, pending, oldest));
        when(records.readRecordResource("tenant", "session", latest.get("catalogRef")))
                .thenReturn(JSON.readTree("""
                        {"tools":[{"name":"current","inputSchema":{"type":"object"}}],
                         "resources":[],"prompts":[],
                         "discovery":{"tools":"complete","resources":"complete","prompts":"complete"}}
                        """));
        JsonNode result = service.get("tenant", "actor", "session");
        assertThat(result.at("/servers/0/tools/0/name").asText()).isEqualTo("current");
        assertThat(result.at("/servers/0/catalog_revision").intValue()).isEqualTo(3);
        assertThat(result.at("/servers/0/discovery/tools").asText()).isEqualTo("complete");
    }

    @Test
    void authorizesBeforeReadingAnyRecordsOrResources() {
        when(sessions.requireReadableSession("tenant", "actor", "session"))
                .thenThrow(new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found."));
        assertThatThrownBy(() -> service.get("tenant", "actor", "session")).isInstanceOf(ApiException.class);
        verifyNoInteractions(records);
    }

    private static ObjectNode configuration(String id, String releaseState) {
        ObjectNode record = JSON.createObjectNode().put("serverId", "server").put("releaseState", releaseState)
                .put("serverRevision", 9).put("configRevision", 9).put("catalogRevision", 3);
        record.putObject("catalogRef").put("resourceId", id);
        return record;
    }
}
