package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedContentConfiguration;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedContentConfigurationTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void rootMustMatchTheDurableSessionHeaderWithoutInventingRuntimeOwnership() throws Exception {
        var root = JSON.readTree("{\"formatVersion\":2,\"executionMode\":\"content-only\",\"sessionKey\":{\"tenantId\":\"t\",\"workspaceId\":\"w\",\"sessionId\":\"s\"},"
                + "\"rootSnapshotRef\":{\"resourceId\":\"root\"},\"definitionRef\":{\"resourceId\":\"definition\"}}");
        var header = root.deepCopy();
        assertDoesNotThrow(() -> ManagedContentConfiguration.requireRoot(root, header));
        ((com.fasterxml.jackson.databind.node.ObjectNode) header.path("definitionRef")).put("resourceId", "foreign");
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedContentConfiguration.requireRoot(root, header));
        ((com.fasterxml.jackson.databind.node.ObjectNode) root).putObject("runtime").put("bindingId", "fake");
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedContentConfiguration.requireRoot(root, root));
    }

    @Test
    void contentAcknowledgementCannotPretendTheRuntimeStagedOrEnabledProcesses() throws Exception {
        var configuration = JSON.readTree("{\"command\":{\"operationId\":\"operation\"},\"configRevision\":1,\"bundleRef\":{\"resourceId\":\"bundle\"}}");
        var ack = JSON.readTree("{\"operationId\":\"operation\",\"revision\":1,\"bundleRef\":{\"resourceId\":\"bundle\"},\"side\":\"harness\"}");
        assertDoesNotThrow(() -> ManagedContentConfiguration.requireAcknowledgement(ack, configuration));
        ((com.fasterxml.jackson.databind.node.ObjectNode) ack).put("side", "runtime");
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedContentConfiguration.requireAcknowledgement(ack, configuration));
    }

    @Test
    void assetPagesRejectTraversalAndExecutableBundleFields() throws Exception {
        var page = JSON.readTree("{\"kind\":\"managed-extension-assets-page\",\"formatVersion\":1,\"files\":[{\"path\":\"../secret\",\"byteLength\":0,\"digest\":\""
                + "a".repeat(64) + "\",\"parts\":[]}]}");
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class,
                () -> ManagedContentConfiguration.assetReferences("managed-extension-assets-page", page));
        var bundle = JSON.readTree("{\"kind\":\"managed-extension-config-bundle\",\"formatVersion\":2,\"configRevision\":1,\"executionMode\":\"content-only\","
                + "\"mcpRevision\":0,\"independentMcpSelections\":[],\"baseMcpServers\":[],\"baseHookCatalog\":null,\"packages\":[],\"mcpServers\":[],\"hookCatalog\":null}");
        assertDoesNotThrow(() -> ManagedContentConfiguration.requireBundle(bundle, ref -> null));
        ((com.fasterxml.jackson.databind.node.ObjectNode) bundle).put("configRevision", 0);
        assertDoesNotThrow(() -> ManagedContentConfiguration.requireBundle(bundle, ref -> null));
        ((com.fasterxml.jackson.databind.node.ObjectNode) bundle).putArray("mcpServers").addObject().put("serverId", "process");
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedContentConfiguration.requireBundle(bundle, ref -> null));
    }
}
