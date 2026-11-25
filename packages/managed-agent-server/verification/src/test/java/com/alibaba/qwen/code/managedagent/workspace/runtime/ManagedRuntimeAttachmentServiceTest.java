package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ManagedRuntimeAttachmentServiceTest {
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final WorkspaceRuntimeResolver workspaces = mock(WorkspaceRuntimeResolver.class);
    private final RuntimeBrokerOperations broker = mock(RuntimeBrokerOperations.class);
    private final RuntimeSessionRepository runtimeSessions = mock(RuntimeSessionRepository.class);
    private final RuntimeBindingRepository bindings = mock(RuntimeBindingRepository.class);
    private final SessionPrincipal principal = SessionPrincipal.ofUser("tenant", "user");
    private ManagedRuntimeAttachmentService service;
    private RuntimeBindingRecord binding;
    private RuntimeSessionRecord runtimeSession;

    @BeforeEach
    void setUp() {
        service = new ManagedRuntimeAttachmentService(sessions, workspaces, broker, runtimeSessions, bindings);
        RuntimeScope scope = new RuntimeScope("tenant", "ma-session", "1", "/root", "sha256:" + "a".repeat(64), "session");
        var context = new ContextBinding("tenant", "ma-session", 1, "storage-1", "sub", "reference", 1);
        SessionRecord session = mock(SessionRecord.class);
        when(session.workspace()).thenReturn(context);
        when(session.sessionId()).thenReturn("native");
        when(sessions.requireReadableSession(principal, "native")).thenReturn(session);
        when(workspaces.resolve("native")).thenReturn(new WorkspaceRuntimeResolver.Resolved(context, scope));
        binding = mock(RuntimeBindingRecord.class);
        when(binding.getRequest()).thenReturn(new RuntimeProvisionRequest(scope, "native", "external-workspace", "storage-1"));
        when(binding.getBindingId()).thenReturn("binding-1");
        when(binding.getGeneration()).thenReturn(7L);
        when(binding.getState()).thenReturn(RuntimeBindingRecord.State.READY);
        when(binding.getAttestationGeneration()).thenReturn(1L);
        when(binding.getProvisionSeed()).thenReturn(mock(RuntimeProvisionSeed.class));
        when(binding.getLease()).thenReturn(new RuntimeLease("worker", URI.create("http://127.0.0.1:43190"), "token", "lease", 1));
        when(binding.getResourceHandle()).thenReturn(new RuntimeResourceHandle("external-workspace", 1, Map.of("request", "provision")));
        when(bindings.findById("binding-1")).thenReturn(binding);
        runtimeSession = mock(RuntimeSessionRecord.class);
        when(runtimeSession.getSession()).thenReturn(new RuntimeSession("native", "native", "bootstrap", scope));
        when(runtimeSession.getBindingId()).thenReturn("binding-1");
        when(runtimeSession.getRuntimeGeneration()).thenReturn(7L);
        when(runtimeSession.isAcquirable()).thenReturn(true);
        when(runtimeSessions.findById(scope, "native")).thenReturn(runtimeSession);
        when(broker.acquire("native", "native", "bootstrap", null, null)).thenReturn(CompletableFuture.completedFuture(runtimeSession));
    }

    @Test
    void acquireUsesTheAuthorizedSessionAndReturnsItsActualAttachment() {
        var attached = service.acquire(principal, "native").toCompletableFuture().join();

        assertEquals("binding-1", attached.binding().getBindingId());
        assertEquals(7, attached.binding().getGeneration());
        verify(broker).acquire("native", "native", "bootstrap", null, null);
    }

    @Test
    void inspectRequiresTheFrozenGenerationAndNeverSelectsAnotherBinding() {
        assertEquals(binding, service.inspect(principal, "native", "binding-1", 7).binding());
        assertThrows(RuntimeBrokerException.class, () -> service.inspect(principal, "native", "binding-1", 8));
        assertThrows(RuntimeBrokerException.class, () -> service.inspect(principal, "native", "another-binding", 7));

        verify(broker, never()).acquire(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), eq(null), eq(null));
    }

    @Test
    void rejectsDifferentSessionAndReadAuthorityBeforeProvisioning() {
        when(sessions.requireReadableSession(SessionPrincipal.ofUser("tenant", "another"), "native")).thenThrow(new RuntimeBrokerException(404,
                "session_not_found", "not found", false));
        when(sessions.requireReadableSession(principal, "another-session")).thenThrow(new RuntimeBrokerException(404,
                "session_not_found", "not found", false));
        assertThrows(RuntimeBrokerException.class, () -> service.acquire(SessionPrincipal.ofUser("tenant", "another"), "native"));
        assertThrows(RuntimeBrokerException.class, () -> service.acquire(principal, "another-session"));

        verify(broker, never()).acquire(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }
}
