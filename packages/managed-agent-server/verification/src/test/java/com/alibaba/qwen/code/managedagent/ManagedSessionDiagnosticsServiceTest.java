package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.ModelDiagnostics;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.session.ManagedSessionDiagnosticsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedSessionDiagnosticsServiceTest {
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final ManagedSessionDiagnosticsService service = new ManagedSessionDiagnosticsService(sessions, records);

    @Test
    void publishesOnlyTheBoundedPublicFieldsAndPreservesCoverageAndFreshness() throws Exception {
        var fixture = new ObjectMapper().readTree(VerificationFixtures.moduleRoot()
                .resolve("../core/src/managed-runtime/contracts/managed-model-statistics-v1.fixtures.json").toFile())
                .get("valid").get(0).get("body");
        var session = mock(SessionRecord.class);
        when(session.sessionId()).thenReturn("session");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(records.findModelDiagnostics("tenant", "session")).thenReturn(new ModelDiagnostics(
                fixture.get("context"), fixture.get("statistics"), 10L, 11L, 0L, 12L, true,
                List.of("unclosed_turn")));

        JsonNode context = service.context("tenant", "actor", "session");
        assertThat(context.path("context").has("providerPin")).isFalse();
        assertThat(context.path("stale").asBoolean()).isTrue();
        assertThat(context.path("sourceSequence").asText()).isEqualTo("10");
        assertThat(context.path("staleReasons").get(0).asText()).isEqualTo("context_changed");
        assertThat(OpenApiContract.load().validate("/components/schemas/ManagedDiagnosticContextUsage", context))
                .isEmpty();

        JsonNode statistics = service.statistics("tenant", "actor", "session");
        assertThat(statistics.path("statistics").has("rawOutputTokensTotal")).isFalse();
        assertThat(statistics.path("statistics").has("budget")).isFalse();
        assertThat(statistics.path("availability").asText()).isEqualTo("partial");
        assertThat(statistics.path("coverageReasons").get(0).asText()).isEqualTo("unclosed_turn");
        assertThat(statistics.path("readRevision").asText()).isEqualTo("12");
        assertThat(OpenApiContract.load().validate("/components/schemas/ManagedDiagnosticStats", statistics)).isEmpty();
    }

    @Test
    void authorizesBeforeReadingAnyPrivateResources() {
        when(sessions.requireReadableSession("tenant", "stranger", "session"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "Session not found"));
        assertThatThrownBy(() -> service.context("tenant", "stranger", "session"))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> service.statistics("tenant", "stranger", "session"))
                .isInstanceOf(ManagedAgentException.class);
        verifyNoInteractions(records);
    }

    @Test
    void doesNotInventObservationsForLegacySessions() {
        var session = mock(SessionRecord.class);
        when(session.sessionId()).thenReturn("session");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(records.findModelDiagnostics("tenant", "session"))
                .thenReturn(new ModelDiagnostics(null, null, null, null, null, null, false, List.of()));
        JsonNode result = service.statistics("tenant", "actor", "session");
        assertThat(result.path("availability").asText()).isEqualTo("unsupported");
        assertThat(result.path("statistics").isNull()).isTrue();
        verify(records).findModelDiagnostics("tenant", "session");
    }
}
