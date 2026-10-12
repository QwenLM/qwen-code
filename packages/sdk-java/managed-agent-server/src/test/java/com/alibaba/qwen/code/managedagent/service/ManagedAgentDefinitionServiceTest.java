package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.AgentDefinitionRequest;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentDefinitionService.Result;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.Admission;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.ConcurrentWriteException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.DefinitionRevision;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;

/**
 * A write that loses a race to a concurrent request: the same request
 * replays the committed result, and only a different or unrecorded request
 * keeps its conflict.
 */
class ManagedAgentDefinitionServiceTest {
    private static final String AGENT_ID = "agent_" + "1".repeat(32);
    private static final AgentDefinitionRequest REQUEST =
            new AgentDefinitionRequest(Map.of("id", "test-model"),
                    "Review the change.", List.of(Map.of("name", "read_file")),
                    null, null, Map.of("mode", "default"), null, null);
    private static final DefinitionRevision WINNER = new DefinitionRevision(
            AGENT_ID, 1, "a".repeat(64), "{\"metadata\":{\"team\":\"x\"}}", 7);
    private static final Map<String, Object> CONTENT = Map.of(
            "model", REQUEST.model(), "instructions", REQUEST.instructions(),
            "tools", REQUEST.tools(), "permission_policy", REQUEST.permissionPolicy());
    private static final String CREATE_DIGEST = new RequestDigests().digest(
            Map.of("operation", "create", "definition", CONTENT));
    private static final String UPDATE_DIGEST = new RequestDigests().digest(
            Map.of("operation", "update", "agentId", AGENT_ID, "definition", CONTENT));

    private final ManagedAgentDefinitionStore store =
            mock(ManagedAgentDefinitionStore.class);
    private final ManagedAgentDefinitionService service =
            new ManagedAgentDefinitionService(store, new RequestDigests(),
                    new ObjectMapper());

    @Test
    void replaysTheCommittedResultOfAConcurrentIdenticalCreate() {
        when(store.create(eq("tenant"), eq("key"), eq(CREATE_DIGEST), anyString(),
                anyString(), anyString(), anyLong()))
                .thenThrow(new ConcurrentWriteException("idempotency_conflict",
                        "The Idempotency-Key was used by a concurrent request."));
        when(store.replayCommitted("tenant", "key", CREATE_DIGEST))
                .thenReturn(Optional.of(new Admission(WINNER, true)));

        Result result = service.create("tenant", "key", REQUEST);

        assertThat(result.replayed()).isTrue();
        assertThat(result.definition().id()).isEqualTo(AGENT_ID);
        assertThat(result.definition().revision()).isEqualTo("1");
        assertThat(result.definition().metadata()).containsEntry("team", "x");
    }

    @Test
    void replaysAConcurrentIdenticalUpdate() {
        when(store.update(eq("tenant"), eq("key"), eq(UPDATE_DIGEST), eq(AGENT_ID),
                anyString(), anyString(), anyLong()))
                .thenThrow(new ConcurrentWriteException(
                        "agent_revision_conflict", "changed"));
        when(store.replayCommitted("tenant", "key", UPDATE_DIGEST))
                .thenReturn(Optional.of(new Admission(WINNER, true)));

        assertThat(service.update("tenant", AGENT_ID, "key", REQUEST)
                .replayed()).isTrue();
    }

    @Test
    void keepsTheConflictWhenNoCommandWasCommittedUnderTheKey() {
        when(store.update(eq("tenant"), eq("key"), eq(UPDATE_DIGEST), eq(AGENT_ID),
                anyString(), anyString(), anyLong()))
                .thenThrow(new ConcurrentWriteException(
                        "agent_revision_conflict", "changed"));
        when(store.replayCommitted("tenant", "key", UPDATE_DIGEST))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.update("tenant", AGENT_ID, "key",
                REQUEST))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("agent_revision_conflict");
                });
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void conflictsWhenTheCommittedRequestDiffers(boolean update) {
        if (update) {
            when(store.update(eq("tenant"), eq("key"), eq(UPDATE_DIGEST), eq(AGENT_ID),
                    anyString(), anyString(), anyLong()))
                    .thenThrow(new ConcurrentWriteException("agent_revision_conflict", "changed"));
        } else {
            when(store.create(eq("tenant"), eq("key"), eq(CREATE_DIGEST), anyString(),
                    anyString(), anyString(), anyLong()))
                    .thenThrow(new ConcurrentWriteException("idempotency_conflict",
                            "The Idempotency-Key was used by a concurrent request."));
        }
        when(store.replayCommitted("tenant", "key", update ? UPDATE_DIGEST : CREATE_DIGEST))
                .thenThrow(new ApiException(HttpStatus.CONFLICT,
                        "idempotency_conflict", "different request"));

        assertThatThrownBy(() -> {
            if (update) {
                service.update("tenant", AGENT_ID, "key", REQUEST);
            } else {
                service.create("tenant", "key", REQUEST);
            }
        })
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
    }
}
