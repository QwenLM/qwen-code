package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedContentPackageAuthorizationTest {
    private final String operation = "11111111-1111-4111-8111-111111111111";
    private final Pin pin = new Pin("extension", 1, "a".repeat(64), null);
    private JdbcManagedSessionStore writers;
    private JdbcManagedSessionSkills skills;
    private AgentStateStore sessions;
    private ManagedContentPackageAuthorization authorization;

    @BeforeEach
    void setup() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:content-package-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        ManagedSchema.initialize(source);
        writers = mock(JdbcManagedSessionStore.class);
        skills = mock(JdbcManagedSessionSkills.class);
        sessions = mock(AgentStateStore.class);
        var session = mock(SessionRecord.class);
        when(session.toolProfile()).thenReturn(WorkspaceToolProfiles.EXTERNAL_CONTENT);
        when(session.publicChildAgentsVersion()).thenReturn(1);
        when(session.agentId()).thenReturn("qwen-code");
        when(session.workspace()).thenReturn(new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1));
        when(sessions.requireSession("tenant", "session")).thenReturn(session);
        when(skills.initialSelection("tenant", "session")).thenReturn(Map.of("operationId", operation, "extensions",
                List.of(Map.of("extensionId", pin.extensionId(), "packageRevision", pin.packageRevision(), "packageDigest", pin.packageDigest()))));
        authorization = new ManagedContentPackageAuthorization(new JdbcTemplate(source), writers,
                mock(JdbcManagedExtensionRecordStore.class), skills, sessions);
    }

    @Test
    void authorizesOnlyTheExactCreationOperationAndPinThroughItsWriterFence() {
        assertDoesNotThrow(() -> authorize(operation, pin));
        verify(writers).authorizeOrdinary("tenant", "session", "token",
                new AuthorizeLifecycleRequest("workspace", "writer", 7, "configuration:" + operation));
        assertThrows(ManagedAgentException.class, () -> authorize("22222222-2222-4222-8222-222222222222", pin));
        assertThrows(ManagedAgentException.class, () -> authorize(operation, new Pin("other", 1, pin.packageDigest(), null)));
    }

    @Test
    void staleWriterCannotReachSelectionOrPackageScope() {
        doThrow(new ManagedAgentException(409, "writer_conflict", "stale writer")).when(writers).authorizeOrdinary(
                "tenant", "session", "token", new AuthorizeLifecycleRequest("workspace", "writer", 7, "configuration:" + operation));
        assertThrows(ManagedAgentException.class, () -> authorize(operation, pin));
        verifyNoInteractions(skills, sessions);
    }

    @Test
    void settingsPinsAreRejectedBeforeAnyWriterOrSelectionRead() {
        assertThrows(ManagedAgentException.class, () -> authorize(operation, new Pin(pin.extensionId(), 1, pin.packageDigest(), 1L)));
        verifyNoInteractions(writers, skills, sessions);
    }

    private void authorize(String operationId, Pin selected) {
        authorization.authorize("tenant", "session", "token", "workspace", "writer", 7, operationId, selected);
    }
}
