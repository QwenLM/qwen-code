package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DuplicateKeyException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * #13803 (K1): the workflow creation arm mints a `workflow_launch` first
 * turn from the parent's pin and envelopes, and its replay answers by the
 * derived creation key exactly like the prompt arm.
 */
class ManagedAgentServiceWorkflowChildTest {
    private static final String TENANT = "tenant";
    private static final String PARENT = "parent";
    private static final String RUN = "run-1";
    private static final String DIGEST = "a".repeat(64);
    private static final String SCRIPT = "return args.x + 1;";

    private final AgentStateStore store = mock(AgentStateStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private ManagedAgentService service;

    @BeforeEach
    void setUp() {
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.requireSession(TENANT, PARENT)).thenReturn(new StoreModels.SessionRecord(TENANT, PARENT,
                "qwen-code", null, "parent", "ACTIVE", null, null, 0, 0, 0, 0, 0, null, 0,
                new ContextBinding(TENANT, "workspace", 1, "storage", "project",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), null, null));
        when(store.insertChildSessionCommand(anyString(), anyString(), anyString(), anyString(), anyString(),
                anyList(), any(), any(StoreModels.SessionLineage.class)))
                .thenReturn(new StoreModels.Admission("workflow-child", null, false, true));
        service = new ManagedAgentService(store, new RequestDigests(), null, harness, null);
    }

    @Test
    void theFirstTurnCarriesTheWorkflowLaunchBlock() {
        assertThat(service.createWorkflowChildSession(TENANT, PARENT, RUN,
                "workflow/audit", 1L, DIGEST, SCRIPT, Map.of("x", 1))
                .sessionId()).isEqualTo("workflow-child");

        ArgumentCaptor<List<Map<String, Object>>> input =
                ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> title = ArgumentCaptor.forClass(String.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT),
                anyString(), anyString(), title.capture(), input.capture(),
                any(), any(StoreModels.SessionLineage.class));
        assertThat(title.getValue()).isEqualTo("workflow/audit");
        assertThat(input.getValue()).containsExactly(Map.of("type",
                "workflow_launch", "definition", Map.of("definitionId",
                        "workflow/audit", "definitionRevision", 1L,
                        "definitionDigest", DIGEST), "script", SCRIPT, "args",
                Map.of("x", 1)));
    }

    @Test
    void absentArgumentsStayOffTheBlock() {
        service.createWorkflowChildSession(TENANT, PARENT, RUN,
                "workflow/audit", 1L, DIGEST, SCRIPT, null);
        ArgumentCaptor<List<Map<String, Object>>> input =
                ArgumentCaptor.forClass(List.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT),
                anyString(), anyString(), anyString(), input.capture(), any(),
                any(StoreModels.SessionLineage.class));
        assertThat(input.getValue().get(0)).doesNotContainKey("args");
    }

    @Test
    void aLostReplyReplaysByTheDerivedKeyWithTheSameDigest() {
        when(store.insertChildSessionCommand(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyList(), any(),
                any(StoreModels.SessionLineage.class)))
                .thenThrow(new DuplicateKeyException("lost reply"));
        when(store.replayChildSessionCommand(eq(TENANT), eq(PARENT),
                anyString(), anyString()))
                .thenReturn(new StoreModels.Admission("workflow-child", null,
                        true, true));

        assertThat(service.createWorkflowChildSession(TENANT, PARENT, RUN,
                "workflow/audit", 1L, DIGEST, SCRIPT, null).sessionId())
                .isEqualTo("workflow-child");

        ArgumentCaptor<String> attemptedKey =
                ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> attempted = ArgumentCaptor.forClass(String.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT),
                attemptedKey.capture(), attempted.capture(), anyString(),
                anyList(), any(), any(StoreModels.SessionLineage.class));
        ArgumentCaptor<String> replayedKey =
                ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> replayed = ArgumentCaptor.forClass(String.class);
        verify(store).replayChildSessionCommand(eq(TENANT), eq(PARENT),
                replayedKey.capture(), replayed.capture());
        // The replay must answer by the derivation a lost reply actually
        // carries — not merely repeat whatever digest the insert attempted:
        // both name the canonical (sorted-key) request the creation is,
        // hashed here independently of RequestDigests.
        assertThat(replayedKey.getValue()).isEqualTo(attemptedKey.getValue())
                .isEqualTo(ManagedAgentService.childCreationKey(PARENT, RUN));
        String expected = sha256("{\"child\":\"" + RUN + "\",\"input\":[{"
                + "\"definition\":{\"definitionDigest\":\"" + DIGEST + "\","
                + "\"definitionId\":\"workflow/audit\","
                + "\"definitionRevision\":1},"
                + "\"script\":\"" + SCRIPT + "\","
                + "\"type\":\"workflow_launch\"}],"
                + "\"title\":\"workflow/audit\"}");
        assertThat(attempted.getValue()).isEqualTo(expected);
        assertThat(replayed.getValue()).isEqualTo(expected);
    }

    private static String sha256(String canonical) {
        try {
            byte[] hashed = MessageDigest.getInstance("SHA-256")
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder("sha256:");
            for (byte item : hashed) {
                result.append(String.format("%02x", item & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    @Test
    void loneSurrogatesTradeForReplacementBeforeTheDigestAndTheInsert() {
        String raw = "x surrogate " + (char) 0xD800 + " here";
        assertThat(service.createWorkflowChildSession(TENANT, PARENT, RUN,
                "workflow/audit", 1L, DIGEST, raw, Map.of("note", raw))
                .sessionId()).isEqualTo("workflow-child");

        ArgumentCaptor<List<Map<String, Object>>> input =
                ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> digest = ArgumentCaptor.forClass(String.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT),
                anyString(), anyString(), anyString(), input.capture(),
                digest.capture(), any(StoreModels.SessionLineage.class));
        Map<String, Object> block = input.getValue().get(0);
        String normalized = raw.replace((char) 0xD800, '�');
        assertThat(block.get("script")).isEqualTo(normalized);
        assertThat(block.get("args")).isEqualTo(Map.of("note", normalized));
        // The digest names the representation the column keeps: recomputing
        // it from the persisted input round-trips instead of wedging the Turn.
        assertThat(digest.getValue()).isEqualTo(
                SubmitHarnessTurn.computePayloadDigest(input.getValue()));
    }

    @Test
    void userTextWithALoneSurrogateIsNormalizedTheSameWay() {
        when(harness.isAvailable()).thenReturn(true);
        when(store.insertSessionCommand(anyString(), anyString(), anyString(),
                anyString(), anyString(), any(), any(), any(), anyList(),
                anyString())).thenReturn(new StoreModels.Admission(
                        "session-new", null, false, true));
        String raw = "x surrogate " + (char) 0xD800 + " here";

        service.createSession(TENANT, "actor", "key-1", null, null, null,
                null, List.of(new ApiModels.InputBlock("text", raw)));

        ArgumentCaptor<List<Map<String, Object>>> input =
                ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> digest = ArgumentCaptor.forClass(String.class);
        verify(store).insertSessionCommand(anyString(), anyString(),
                anyString(), anyString(), anyString(), any(), any(), any(),
                input.capture(), digest.capture());
        List<Map<String, Object>> inserted = input.getValue();
        String normalized = raw.replace((char) 0xD800, '�');
        assertThat(inserted).containsExactly(
                Map.of("type", "text", "text", normalized));
        assertThat(digest.getValue()).isEqualTo(
                SubmitHarnessTurn.computePayloadDigest(inserted));
    }

    @Test
    void replaceLoneSurrogatesTradesOnlyTheUnpaired() {
        assertThat(ManagedAgentService.replaceLoneSurrogates(
                "x" + (char) 0xD800)).isEqualTo("x" + '�');
        assertThat(ManagedAgentService.replaceLoneSurrogates(
                "x" + (char) 0xDFFF + "y")).isEqualTo("x" + '�' + "y");
        assertThat(ManagedAgentService.replaceLoneSurrogates("café 中 😀"))
                .isEqualTo("café 中 😀");
        assertThat(ManagedAgentService.replaceLoneSurrogates("plain"))
                .isEqualTo("plain");
    }
}
