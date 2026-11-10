package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ManagedSessionResourcesServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DIGEST = "b".repeat(64);
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final ManagedSessionSkills skills = mock(ManagedSessionSkills.class);
    private final ManagedAgentDefinitionStore definitions = mock(ManagedAgentDefinitionStore.class);
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final SessionRecord session = mock(SessionRecord.class);
    private final Map<String, StoredResource> resources = new LinkedHashMap<>();
    private final ManagedSessionResourcesService service = new ManagedSessionResourcesService(sessions, skills, definitions, records, JSON);

    @BeforeEach
    void reader() {
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(session.workspace()).thenReturn(mock(ContextBinding.class));
        when(session.toolProfile()).thenReturn("hosted-workspace-shell/1");
        when(skills.effective(session)).thenReturn(List.of());
        when(records.diagnosticConfigRef("tenant", "session")).thenReturn(Optional.empty());
        when(records.diagnosticMcpRecordRefs("tenant", "session", 257)).thenReturn(List.of());
        when(records.diagnosticReadRevision("tenant", "session")).thenReturn("9999999999999999");
        when(records.readCommittedResource(eq("tenant"), eq("session"), any())).thenAnswer(invocation -> {
            JsonNode ref = invocation.getArgument(2);
            StoredResource resource = resources.get(ref.path("resourceId").asText());
            if (resource == null) {
                throw new ManagedAgentException(409, "resource_missing", "Unavailable");
            }
            return resource;
        });
    }

    @Test
    void includesBaseModelOnlySkillsAndActiveExtensionSkillsAndCommandsWithoutPrivateContent() throws Exception {
        when(skills.effective(session)).thenReturn(List.of(Map.of("name", "model-only", "description", "Base",
                "body", "PRIVATE-BODY", "model_invocable", true, "user_invocable", false)));
        ObjectNode contributions = JSON.createObjectNode();
        contributions.putArray("skills").addObject().put("name", "package-skill").put("description", "Package")
                .put("body", "PRIVATE-PACKAGE").put("model_invocable", false).put("user_invocable", true);
        contributions.putArray("commands").addObject().put("name", "build").put("description", "Command")
                .put("prompt", "PRIVATE-PROMPT").put("modelInvocable", true);
        contributions.putObject("mcpServers").putObject("search").put("command", "PRIVATE-COMMAND");
        ObjectNode contributionRef = contributions(contributions);
        ObjectNode bundle = bundle(1);
        bundle.withArray("packages").addObject().set("pin", JSON.createObjectNode().put("extensionId", "package"));
        ((ObjectNode) bundle.path("packages").get(0)).set("contributionsRef", contributionRef);
        bundle.withArray("mcpServers").add(pin("package:search"));
        latest(config(1, 1, "active", null, resource("managed-extension-config-bundle", bundle), null));
        var result = get();
        assertThat(result.path("availability").asText()).isEqualTo("available");
        assertThat(result.path("readRevision").asText()).isEqualTo("9999999999999999");
        assertThat(result.path("skills")).hasSize(3);
        assertThat(result.at("/skills/0/modelInvocable").asBoolean()).isTrue();
        assertThat(result.at("/skills/0/userInvocable").asBoolean()).isFalse();
        assertThat(result.at("/skills/1/modelInvocable").asBoolean()).isFalse();
        assertThat(result.at("/skills/1/extensionId").asText()).isEqualTo("package");
        assertThat(result.at("/skills/2/kind").asText()).isEqualTo("command");
        assertThat(result.at("/skills/2/userInvocable").asBoolean()).isTrue();
        assertThat(result.at("/servers/0/origin").asText()).isEqualTo("extension");
        assertThat(result.at("/servers/0/liveState").asText()).isEqualTo("unknown");
        assertThat(result.at("/servers/0/discovery/tools").asText()).isEqualTo("unknown");
        assertThat(result.toString()).doesNotContain("PRIVATE", "contributionsRef", "definitionDigest", "assetRoot");
    }

    @Test
    void usesTheLastActiveBundleInsteadOfANewerFailedOperationsPreviousBundle() throws Exception {
        ObjectNode active = bundle(1);
        active.withArray("independentMcpSelections").add(pin("active").put("state", "disabled"));
        ObjectNode activeRef = resource("managed-extension-config-bundle", active);
        ObjectNode committed = resource("managed-config_install", config(1, 1, "active", null, activeRef, null));
        ObjectNode wrong = bundle(2);
        wrong.withArray("independentMcpSelections").add(pin("wrong").put("state", "enabled"));
        latest(config(2, 2, "failed", committed, null, resource("managed-extension-config-bundle", wrong)));
        var result = get();
        assertThat(result.path("activeOperationPhase").asText()).isEqualTo("failed");
        assertThat(result.path("activeConfigRevision").asInt()).isEqualTo(1);
        assertThat(result.at("/servers/0/serverId").asText()).isEqualTo("active");
        assertThat(result.at("/servers/0/selectionState").asText()).isEqualTo("disabled");
        assertThat(result.toString()).doesNotContain("wrong");
    }

    @Test
    void boundsRetainedTombstonesInIndependentSelections() throws Exception {
        ObjectNode active = bundle(1);
        addSelections(active, 32, 192);
        ObjectNode activeRef = resource("managed-extension-config-bundle", active);
        latest(config(1, 1, "active", null, activeRef, null));
        assertThat(get().path("configCoverage").asText()).isEqualTo("complete");

        ObjectNode overfilled = bundle(1);
        addSelections(overfilled, 32, 193);
        ObjectNode overfilledRef = resource("managed-extension-config-bundle", overfilled);
        latest(config(1, 1, "active", null, overfilledRef, null));
        JsonNode rejected = get();
        assertThat(rejected.path("configCoverage").asText()).isEqualTo("partial");
        assertThat(rejected.path("coverageReasons").toString()).contains("invalid_resource");
    }

    @Test
    void boundsTheConfigurationChainAndDoesNotInventAnActiveBundle() throws Exception {
        ObjectNode activeRef = resource("managed-extension-config-bundle", bundle(0));
        ObjectNode previous = null;
        for (int revision = 1; revision <= 64; revision++) {
            ObjectNode record = config(revision, 1, revision % 2 == 1 ? "preparing" : "failed", previous, null, activeRef);
            String operation = "12345678-1234-4234-8234-" + String.format("%012d", (revision + 1) / 2);
            record.put("operationId", operation).put("phaseOperationId", operation);
            record.withObject("/command").put("operationId", operation);
            previous = resource("managed-config_install", record);
        }
        when(records.diagnosticConfigRef("tenant", "session")).thenReturn(Optional.of(previous));
        assertThat(get().path("configCoverage").asText()).isEqualTo("complete");
        latest(config(65, 1, "preparing", previous, null, activeRef));
        var bounded = get();
        assertThat(bounded.path("configCoverage").asText()).isEqualTo("partial");
        assertThat(bounded.path("activeConfigRevision").isNull()).isTrue();
        assertThat(bounded.path("coverageReasons").toString()).contains("configuration_history_limit");
    }

    @Test
    void separatesARecentFailedAttemptFromThePublishedCatalogAndHonorsSelectionAndRelease() throws Exception {
        selection(pin("server").put("state", "enabled"));
        ObjectNode catalog = catalog(1);
        ObjectNode published = configuration(1, resource("managed-mcp-catalog", catalog));
        ObjectNode failed = configuration(2, null);
        failed.withObject("/run").put("state", "failed").put("execution", "outcome_unknown");
        failed.put("serverRevision", 2);
        failed.withObject("/run/definition").put("definitionRevision", 2);
        history(failed, published);
        JsonNode result = get();
        assertThat(result.at("/servers/0/attemptRevision").asInt()).isEqualTo(2);
        assertThat(result.at("/servers/0/attemptServerRevision").asInt()).isEqualTo(2);
        assertThat(result.at("/servers/0/serverRevision").asInt()).isEqualTo(1);
        assertThat(result.at("/servers/0/catalogServerRevision").asInt()).isEqualTo(1);
        assertThat(result.at("/servers/0/lastAttemptState").asText()).isEqualTo("failed");
        assertThat(result.at("/servers/0/lastExecutionState").asText()).isEqualTo("outcome_unknown");
        assertThat(result.at("/servers/0/catalogRevision").asInt()).isEqualTo(1);
        assertThat(result.at("/servers/0/historical").asBoolean()).isTrue();
        assertThat(result.at("/servers/0/discovery/tools").asText()).isEqualTo("stale");
        assertThat(result.at("/servers/0/tools/0/name").asText()).isEqualTo("search");
        assertThat(result.toString()).doesNotContain("PRIVATE", "inputSchema", "arguments", "headers");
        history(published);
        assertThat(get().at("/servers/0/discovery/tools").asText()).isEqualTo("complete");
        published.put("releaseState", "released");
        history(published);
        assertThat(get().at("/servers/0/discovery/tools").asText()).isEqualTo("stale");
        selection(pin("server").put("state", "removed"));
        assertThat(get().at("/servers/0/selectionState").asText()).isEqualTo("removed");
    }

    @Test
    void readsThirtyTwoLiveSelectionsPlusRetainedTombstonesAndRejectsAnOverfilledLiveCount() throws Exception {
        ObjectNode settings = JSON.createObjectNode().put("kind", "hosted-mcp-settings");
        ArrayNode servers = settings.putArray("servers");
        for (int index = 0; index < 32; index++) {
            servers.add(pin("live-" + index).put("state", "disabled"));
        }
        servers.add(pin("tombstone").put("state", "removed"));
        latest(settings);
        var accepted = get();
        assertThat(accepted.path("availability").asText()).isEqualTo("available");
        assertThat(accepted.path("servers")).hasSize(33);

        servers.add(pin("live-32").put("state", "disabled"));
        latest(settings);
        var rejected = get();
        assertThat(rejected.path("availability").asText()).isEqualTo("partial");
        assertThat(rejected.path("configCoverage").asText()).isEqualTo("partial");
        assertThat(rejected.path("coverageReasons").toString()).contains("invalid_resource");
        assertThat(rejected.path("servers")).isEmpty();
    }

    @Test
    void marksAHistoryWindowHistoricalAndDoesNotReadTheSentinel() throws Exception {
        selection(pin("server").put("state", "enabled"));
        ObjectNode published = configuration(1, resource("managed-mcp-catalog", catalog(1)));
        ObjectNode ref = resource("managed-mcp_configuration", published);
        List<JsonNode> refs = new ArrayList<>(java.util.Collections.nCopies(256, ref));
        ObjectNode sentinel = resource("managed-mcp_configuration", configuration(257, null));
        refs.add(sentinel);
        when(records.diagnosticMcpRecordRefs("tenant", "session", 257)).thenReturn(refs);
        var result = get();
        assertThat(result.path("historyCoverage").asText()).isEqualTo("partial");
        for (String field : List.of("attemptRevision", "attemptServerRevision", "lastAttemptState", "lastExecutionState", "releaseState")) {
            assertThat(result.at("/servers/0/" + field).isNull()).isTrue();
        }
        assertThat(result.at("/servers/0/historical").asBoolean()).isTrue();
        assertThat(result.at("/servers/0/discovery/tools").asText()).isEqualTo("stale");
        verify(records, never()).readCommittedResource("tenant", "session", sentinel);
    }

    @Test
    void enforcesReadAndOutputBudgetsInUtf8Bytes() throws Exception {
        ObjectNode oversized = resource("managed-config_install", JSON.createObjectNode());
        oversized.put("byteLength", 8 * 1024 * 1024 + 1);
        when(records.diagnosticConfigRef("tenant", "session")).thenReturn(Optional.of(oversized));
        var limited = get();
        assertThat(limited.path("coverageReasons").toString()).contains("resource_read_limit");
        verify(records, never()).readCommittedResource("tenant", "session", oversized);
        selection(pin("server").put("state", "enabled"));
        List<Map<String, Object>> catalog = new ArrayList<>();
        for (int index = 0; index < 256; index++) {
            catalog.add(Map.of("name", "skill-" + index, "description", "界".repeat(1365), "body", "a"));
        }
        when(skills.effective(session)).thenReturn(catalog);
        history(configuration(1, resource("managed-mcp-catalog", catalog(1))));
        var truncated = get();
        assertThat(JSON.writeValueAsBytes(truncated).length).isLessThanOrEqualTo(1024 * 1024);
        assertThat(truncated.path("outputTruncated").asBoolean()).isTrue();
        assertThat(truncated.path("availability").asText()).isEqualTo("partial");
        assertThat(truncated.path("configCoverage").asText()).isEqualTo("partial");
        assertThat(truncated.path("historyCoverage").asText()).isEqualTo("complete");
        assertThat(truncated.at("/servers/0/lastAttemptState").asText()).isEqualTo("settled");
        assertThat(truncated.at("/servers/0/releaseState").asText()).isEqualTo("active");
    }

    @Test
    void capabilityOutputTruncationRemovesClaimsAboutCompleteHistory() throws Exception {
        selection(pin("server").put("state", "enabled"));
        ObjectNode catalog = catalog(1);
        for (int index = 0; index < 256; index++) {
            catalog.withArray("tools").addObject().put("name", "tool-" + index).put("description", "界".repeat(1365));
        }
        history(configuration(1, resource("managed-mcp-catalog", catalog)));
        var truncated = get();
        assertThat(JSON.writeValueAsBytes(truncated).length).isLessThanOrEqualTo(1024 * 1024);
        assertThat(truncated.path("outputTruncated").asBoolean()).isTrue();
        assertThat(truncated.path("historyCoverage").asText()).isEqualTo("partial");
        for (String field : List.of("attemptRevision", "attemptServerRevision", "lastAttemptState", "lastExecutionState", "releaseState")) {
            assertThat(truncated.at("/servers/0/" + field).isNull()).isTrue();
        }
        assertThat(truncated.at("/servers/0/discovery/tools").asText()).isEqualTo("stale");
    }

    @Test
    void authorizesBeforeReadingAndDistinguishesUnsupportedFromAnEmptyInventory() {
        when(sessions.requireReadableSession("tenant", "denied", "session"))
                .thenThrow(new ManagedAgentException(404, "session_not_found", "Not found"));
        assertThatThrownBy(() -> service.get("tenant", "denied", "session"))
                .hasFieldOrPropertyWithValue("code", "session_not_found");
        verifyNoInteractions(skills, definitions);
        verify(records, never()).diagnosticReadRevision(any(), any());
        assertThat(get().path("availability").asText()).isEqualTo("available");
        when(session.workspace()).thenReturn(null);
        assertThat(get().path("availability").asText()).isEqualTo("unsupported");
    }

    private JsonNode get() {
        return service.get("tenant", "actor", "session");
    }

    private void latest(ObjectNode config) throws Exception {
        when(records.diagnosticConfigRef("tenant", "session")).thenReturn(Optional.of(resource("managed-config_install", config)));
    }

    private void selection(ObjectNode pin) throws Exception {
        ObjectNode settings = JSON.createObjectNode().put("kind", "hosted-mcp-settings");
        settings.putArray("servers").add(pin);
        latest(settings);
    }

    private void history(ObjectNode... recordsToSave) throws Exception {
        List<JsonNode> refs = new ArrayList<>();
        for (ObjectNode record : recordsToSave) {
            refs.add(resource("managed-mcp_configuration", record));
        }
        when(records.diagnosticMcpRecordRefs("tenant", "session", 257)).thenReturn(refs);
    }

    private ObjectNode resource(String kind, JsonNode value) throws Exception {
        byte[] bytes = JSON.writeValueAsBytes(value);
        String digest = DigestUtils.sha256Hex(bytes);
        String id = kind + "-" + digest;
        resources.put(id, new StoredResource(id, kind, 1, bytes.length, digest, bytes));
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", digest);
    }

    private ObjectNode contributions(ObjectNode value) throws Exception {
        ObjectNode part = resource("managed-extension-contributions-part", value);
        ObjectNode manifest = JSON.createObjectNode().put("kind", "managed-extension-contributions").put("formatVersion", 1)
                .put("byteLength", part.path("byteLength").asInt()).put("digest", part.path("digest").asText());
        manifest.putArray("parts").add(part);
        ObjectNode ref = resource("managed-extension-contributions", manifest);
        when(records.readExtensionContributions("tenant", "session", ref)).thenReturn(value);
        return ref;
    }

    private static ObjectNode pin(String id) {
        return JSON.createObjectNode().put("serverId", id).put("serverRevision", 1).put("definitionDigest", DIGEST);
    }

    private static ObjectNode bundle(int revision) {
        ObjectNode bundle = JSON.createObjectNode().put("kind", "managed-extension-config-bundle").put("formatVersion", 1).put("configRevision", revision);
        bundle.putArray("packages");
        bundle.putArray("mcpServers");
        bundle.putArray("independentMcpSelections");
        return bundle;
    }

    private static void addSelections(ObjectNode bundle, int live, int removed) {
        for (int index = 0; index < live + removed; index++) {
            bundle.withArray("independentMcpSelections").add(pin((index < live ? "live-" : "removed-") + index)
                    .put("state", index == 0 ? "enabled" : index < live ? "disabled" : "removed"));
        }
    }

    private ObjectNode config(int recordRevision, int configRevision, String phase, JsonNode previous, JsonNode bundle, JsonNode baseline) throws Exception {
        String operation = "12345678-1234-4234-8234-" + String.format("%012d", configRevision);
        ObjectNode value = JSON.createObjectNode().put("kind", "hosted-extension-config").put("formatVersion", 1)
                .put("mode", "apply").put("phaseOperationId", operation).put("configRevision", configRevision)
                .put("previousConfigRevision", configRevision - 1).put("phase", phase).put("operationId", operation).put("revision", recordRevision);
        value.set("previousRecordRef", previous == null ? JSON.nullNode() : previous);
        value.set("previousBundleRef", baseline == null ? JSON.nullNode() : baseline);
        value.putNull("restoresBundleRef");
        value.set("bundleRef", bundle == null ? JSON.nullNode() : bundle);
        value.set("rootSnapshotRef", resource("managed-extension-root", JSON.createObjectNode()));
        ObjectNode command = value.putObject("command").put("operationId", operation).put("actorKey", "a".repeat(64)).put("expectedRevision", configRevision - 1);
        command.putArray("extensions");
        ArrayNode stage = value.putArray("stageAckRefs");
        ArrayNode enable = value.putArray("enableAckRefs");
        if ("active".equals(phase)) {
            for (int id = 1; id <= 2; id++) {
                stage.add(resource("managed-extension-stage-ack", JSON.createObjectNode().put("id", id)));
                enable.add(resource("managed-extension-enable-ack", JSON.createObjectNode().put("id", id)));
            }
        }
        if ("failed".equals(phase)) {
            value.putObject("error").put("code", "failed");
        } else {
            value.putNull("error");
        }
        return value;
    }

    private static ObjectNode catalog(int revision) {
        ObjectNode value = JSON.createObjectNode().put("serverId", "server").put("serverRevision", 1)
                .put("definitionDigest", DIGEST).put("configRevision", revision).put("connectionGeneration", 1).put("catalogRevision", 1);
        value.putArray("tools").addObject().put("name", "search").put("description", "Search").putObject("inputSchema").put("private", "PRIVATE");
        value.putArray("resources").addObject().put("name", "note").put("uri", "note:1").put("mimeType", "text/plain");
        value.putArray("prompts");
        value.putObject("discovery").put("tools", "complete").put("resources", "failed").put("prompts", "partial");
        value.putObject("headers").put("Authorization", "PRIVATE");
        return value;
    }

    private static ObjectNode configuration(int revision, JsonNode catalog) throws Exception {
        ObjectNode value = (ObjectNode) JSON.readTree("""
                {"configurationId":"configure-1","runtimeSessionId":"mcp:session","serverId":"server","serverRevision":1,
                 "configRevision":1,"catalogRevision":null,"connectionGeneration":null,"catalogRef":null,"releaseState":"active",
                 "run":{"state":"admitted","reason":null,"definition":{"definitionId":"server","definitionRevision":1,"definitionDigest":"DIGEST"},
                        "executionCallId":null,"effectId":"configure-1","dispatchId":null,"deliveryId":null,"execution":"intent","runtime":null,"delivery":null}}
                """.replace("DIGEST", DIGEST));
        value.put("configurationId", "configure-" + revision).put("configRevision", revision);
        value.withObject("/run").put("effectId", "configure-" + revision);
        if (catalog != null) {
            value.set("catalogRef", catalog);
            value.put("catalogRevision", 1).put("connectionGeneration", 1);
            value.withObject("/run").put("state", "settled").put("execution", "settled")
                    .putObject("runtime").put("runtimeBindingId", "runtime").put("generation", "1");
        }
        return value;
    }
}
