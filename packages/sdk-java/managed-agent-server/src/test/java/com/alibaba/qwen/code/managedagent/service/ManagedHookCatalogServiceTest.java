package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class ManagedHookCatalogServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final ManagedHookCatalogService service = new ManagedHookCatalogService(sessions, records);

    @Test
    void returnsOnlyScalarPlanningFieldsWithoutRecipesOrHandlerImplementations() throws Exception {
        ObjectNode registration = JSON.createObjectNode().put("catalogId", "catalog-1").put("catalogRevision", 2);
        registration.putObject("catalogRef").put("resourceId", "catalog");
        when(records.latestHookRegistration("tenant", "session")).thenReturn(Optional.of(registration));
        when(records.readRecordResource("tenant", "session", registration.get("catalogRef"))).thenReturn(JSON.readTree("""
                {"catalogId":"catalog-1","catalogRevision":2,"definitionDigest":"secret",
                 "hooks":[{"hookId":"hook-1","eventName":"BeforeTool","matcher":"shell","sequential":true,
                   "async":false,"failClosed":true,"onceKey":"secret",
                   "config":{"type":"prompt","prompt":"secret","command":"secret","headers":{"Authorization":"secret"},
                      "env":{"TOKEN":"secret"},"url":"https://secret.invalid","modulePath":"/secret.js"},
                   "handler":{"handlerId":"secret","handlerRevision":1}},
                  {"hookId":"hook-2","eventName":"AfterTool","sequential":false,"async":true,"failClosed":false,
                   "onceKey":null,"config":{"type":"function"},"matcher":{"prompt":"secret"}}]}
                """));
        assertThat(service.get("tenant", "actor", "session")).isEqualTo(JSON.readTree("""
                {"object":"agent.hook_catalog","session_id":"session","catalogs":[{
                  "catalog_id":"catalog-1","catalog_revision":2,"hooks":[
                    {"hook_id":"hook-1","event_name":"BeforeTool","type":"prompt","matcher":"shell",
                     "sequential":true,"async":false,"fail_closed":true,"once":true},
                    {"hook_id":"hook-2","event_name":"AfterTool","type":"function",
                     "sequential":false,"async":true,"fail_closed":false,"once":false}]}]}
                """));
    }

    @Test
    void returnsAnEmptyCatalogBeforeAnyRegistrationSettles() {
        when(records.latestHookRegistration("tenant", "session")).thenReturn(Optional.empty());
        assertThat(service.get("tenant", "actor", "session").path("catalogs")).isEmpty();
    }

    @Test
    void authorizesBeforeReadingRecordsOrResources() {
        when(sessions.requireReadableSession("tenant", "actor", "session"))
                .thenThrow(new ApiException(HttpStatus.NOT_FOUND, "session_not_found", "The Session was not found."));
        assertThatThrownBy(() -> service.get("tenant", "actor", "session")).isInstanceOf(ApiException.class);
        verifyNoInteractions(records);
    }
}
