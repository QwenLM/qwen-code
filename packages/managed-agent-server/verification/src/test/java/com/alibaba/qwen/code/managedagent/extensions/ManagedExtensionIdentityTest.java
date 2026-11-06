package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Operation identity must keep the pre-ownership shape for subjectless
 * principals so keys recorded before the subject column existed still
 * replay, and only an actual subject may fork the identity.
 */
class ManagedExtensionIdentityTest {
    private final SessionPolicyStore store = mock(SessionPolicyStore.class);
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final ManagedExtensionPackageService packages = mock(ManagedExtensionPackageService.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final ObjectMapper json = new ObjectMapper();
    private final ManagedExtensionManagementService service =
            new ManagedExtensionManagementService(store, sessions, records, packages, json, harness);

    @BeforeEach
    void setUp() {
        SessionRecord session = mock(SessionRecord.class);
        when(session.workspace()).thenReturn(new ContextBinding("tenant", "workspace", 1,
                "workspace", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1));
        when(store.requireExtensionManagement(eq("tenant"), eq("actor"), eq("session"), anyString(), eq(true)))
                .thenReturn(session);
        when(harness.supportsSessionExtensions()).thenReturn(true);
        when(harness.applyExtensions(eq("tenant"), eq("session"), any())).thenAnswer(invocation -> {
            Map<String, Object> request = invocation.getArgument(2);
            return Map.of("sessionId", "session",
                    "operation", Map.of("operationId", request.get("operationId")));
        });
    }

    @Test
    void subjectlessIdentityKeepsThePreOwnershipKeyAndOnlyASubjectForksIt() throws Exception {
        JsonNode command = json.readTree("{\"extensions\":[{\"extensionId\":\"docs\",\"packageRevision\":1,"
                + "\"packageDigest\":\"" + "a".repeat(64) + "\"}],\"expectedConfigRevision\":0}");
        String legacy = UUID.nameUUIDFromBytes(
                "managed-extension-apply\0tenant\0actor\0session\0key".getBytes(StandardCharsets.UTF_8)).toString();

        service.submit("tenant", "actor", "session", "key", command);
        SessionPrincipal withSubject = new SessionPrincipal("tenant", "actor", "subject");
        service.submit(withSubject, "session", "key", command);
        service.submit(withSubject, "session", "key", command);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> requests = ArgumentCaptor.forClass(Map.class);
        verify(harness, times(3)).applyExtensions(eq("tenant"), eq("session"), requests.capture());
        var values = requests.getAllValues();
        assertThat(values.get(0).get("operationId")).isEqualTo(legacy);
        assertThat(values.get(1).get("operationId")).isEqualTo(values.get(2).get("operationId"));
        assertThat(values.get(1).get("operationId")).isNotEqualTo(legacy);
    }
}
