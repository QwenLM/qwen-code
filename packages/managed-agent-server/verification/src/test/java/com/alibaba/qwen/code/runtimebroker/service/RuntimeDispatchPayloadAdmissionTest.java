package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RuntimeDispatchPayloadAdmissionTest {
    private static final String REFERENCE_PUBLICATION = "pub-1";
    private static final Map<String, Object> REFERENCE =
            Map.of("dispatchMode", "deferred_v3", "publicationId", REFERENCE_PUBLICATION);

    private final RuntimePublicationVerifier verifier = mock(RuntimePublicationVerifier.class);
    private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
    private final RuntimeDispatchPayloadAdmission admission =
            new RuntimeDispatchPayloadAdmission(verifier, executions, Clock.fixed(
                    Instant.parse("2026-11-20T00:00:00Z"), java.time.ZoneOffset.UTC));

    @Test
    void anExplicitForegroundMarkerAdmitsTheShellPayload() {
        // The control plane validates `is_background` as any boolean and keeps
        // the key, so a foreground command may carry an explicit `false`.
        // Judging the key's presence settled a runnable command as
        // workspace_tool_unsupported instead of dispatching it.
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":false}}";
        var admitted = admission.admit(context(), record(payload), true, payload);
        assertEquals("run_shell_command", admitted.payload().get("toolName"));
        verify(executions, never()).settlePrepared(any(), any(), any());
    }

    @Test
    void aBackgroundMarkerRefusesAndSettlesTheRow() {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\",\"is_background\":true}}";
        var record = record(payload);
        RuntimeBrokerException refusal = assertThrows(RuntimeBrokerException.class,
                () -> admission.admit(context(), record, true, payload));
        assertEquals("runtime_payload_invalid", refusal.getCode());
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> settled = ArgumentCaptor.forClass(Map.class);
        verify(executions).settlePrepared(eq(record), settled.capture(), any(Instant.class));
        assertEquals("not_started", settled.getValue().get("executionStatus"));
        assertEquals("workspace_tool_unsupported",
                ((Map<?, ?>) settled.getValue().get("error")).get("type"));
    }

    private SessionContext context() {
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness", "external-workspace", "workspace");
        var binding = mock(RuntimeBindingRecord.class);
        when(binding.getRequest()).thenReturn(request);
        var context = mock(SessionContext.class);
        when(context.binding()).thenReturn(binding);
        when(verifier.externalShell()).thenReturn(
                mock(com.alibaba.qwen.code.runtimebroker.spi.ExternalShellPublication.class));
        return context;
    }

    private ToolExecutionRecord record(String payload) {
        var record = mock(ToolExecutionRecord.class);
        when(record.getRequestDigest()).thenReturn("sha256:" + DigestUtils.sha256Hex(
                payload.getBytes(StandardCharsets.UTF_8)));
        when(record.getReference()).thenReturn(REFERENCE);
        return record;
    }
}
