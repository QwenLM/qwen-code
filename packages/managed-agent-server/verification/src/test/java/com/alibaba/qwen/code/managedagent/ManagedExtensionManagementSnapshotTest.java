package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionPolicyStore;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionManagementService;
import com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedExtensionManagementSnapshotTest {
    private final ObjectMapper json = new ObjectMapper();
    private final ManagedExtensionRecordStore records = mock(ManagedExtensionRecordStore.class);
    private final ManagedExtensionManagementService service = new ManagedExtensionManagementService(
            mock(SessionPolicyStore.class), mock(ManagedAgentService.class), records,
            mock(ManagedExtensionPackageService.class), json, mock(HarnessConnector.class));

    @Test
    void failedPersonalUpdateReportsTheActivePinsAndTheirBindings() throws Exception {
        verifyFailedUpdate(true);
    }

    @Test
    void failedUpgradeKeepsTheVersionTwoProtocolWithoutRequestedBindings() throws Exception {
        verifyFailedUpdate(false);
    }

    @Test
    void failedInitialApplyHasNoEffectiveBindings() throws Exception {
        ObjectNode requested = bundle("requested", true);
        ObjectNode failed = ManagedConfigInstallContractTest.record(
                ManagedConfigInstallContractTest.content("nullable_preparing"), 1);
        failed.put("phase", "failed").put("previousConfigRevision", 0).putNull("previousRecordRef");
        failed.set("bundleRef", resource("requested", requested));
        ObjectNode snapshot = snapshot(failed);
        assertThat(snapshot.path("selectionVersion").asInt()).isEqualTo(2);
        assertThat(snapshot.path("extensions").isEmpty()).isTrue();
        assertThat(snapshot.path("mcpAuthBindings").isEmpty()).isTrue();
    }

    private void verifyFailedUpdate(boolean personal) throws Exception {
        ObjectNode activeBundle = bundle("active", personal);
        ObjectNode requested = bundle("requested", true);
        ObjectNode active = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content("active"), 1);
        active.put("configRevision", 1).putNull("previousRecordRef");
        active.set("bundleRef", resource("active-bundle", activeBundle));
        ObjectNode failed = ManagedConfigInstallContractTest.record(ManagedConfigInstallContractTest.content("nullable_preparing"), 2);
        failed.put("phase", "failed").put("previousConfigRevision", 1);
        failed.set("bundleRef", resource("requested", requested));
        failed.set("previousRecordRef", resource("active-record", active));
        ObjectNode snapshot = snapshot(failed);
        assertThat(snapshot.path("selectionVersion").asInt()).isEqualTo(2);
        assertThat(snapshot.path("extensions").get(0)).isEqualTo(activeBundle.path("packages").get(0).path("pin"));
        assertThat(snapshot.path("requestedExtensions").get(0)).isEqualTo(requested.path("packages").get(0).path("pin"));
        assertThat(snapshot.path("mcpAuthBindings")).isEqualTo(personal ? activeBundle.path("mcpAuthBindings") : json.createArrayNode());
    }

    private ObjectNode snapshot(ObjectNode body) {
        return ReflectionTestUtils.invokeMethod(service, "snapshot", "tenant", "session", body, true);
    }

    private ObjectNode bundle(String name, boolean personal) {
        String id = "ext_00000000-0000-4000-8000-00000000000" + ("active".equals(name) ? "1" : "2");
        ObjectNode value = json.createObjectNode().put("kind", "managed-extension-config-bundle").put("formatVersion", personal ? 2 : 1);
        value.putArray("packages").addObject().putObject("pin").put("extensionId", id).put("packageRevision", 1).put("packageDigest", "a".repeat(64));
        if (personal) {
            value.putArray("mcpAuthBindings").addObject().put("serverId", id + ":tools")
                    .put("credentialId", "mcred_00000000-0000-4000-8000-000000000001").put("credentialGeneration", 1);
        }
        return value;
    }

    private ObjectNode resource(String id, ObjectNode value) throws IOException {
        ObjectNode ref = json.createObjectNode().put("resourceId", id);
        var stored = mock(StoredResource.class);
        when(stored.bytes()).thenReturn(json.writeValueAsBytes(value));
        when(records.readCommittedResource("tenant", "session", ref)).thenReturn(stored);
        return ref;
    }
}
