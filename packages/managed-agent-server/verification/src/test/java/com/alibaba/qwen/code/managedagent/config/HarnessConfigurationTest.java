package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.persistence.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionSkills;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class HarnessConfigurationTest {
    @Test
    void standaloneConnectorRetainsResourcesBehindTheSdkBoundary() {
        var properties = new ManagedAgentProperties();
        properties.getHarness().setToken("test-harness-token");
        properties.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        var skills = mock(ManagedSessionSkills.class);
        var extensions = mock(ManagedExtensionRecordStore.class);
        var json = new ObjectMapper();
        try (var boundary = new HarnessConfiguration().hostedHarnessConnector(properties,
                mock(AgentStateStore.class), mock(WorkspaceExecutionStore.class),
                mock(ManagedActionStore.class), mock(ManagedAgentDefinitionStore.class),
                mock(ManagedSessionStore.class), mock(SshWorkspaceStore.class),
                mock(HarnessPlacementStore.class), skills, json, extensions)) {
            Object connector = ReflectionTestUtils.getField(boundary, "delegate");
            assertThat(ReflectionTestUtils.getField(connector, "sessionSkills")).isSameAs(skills);
            assertThat(ReflectionTestUtils.getField(connector, "extensions")).isSameAs(extensions);
            assertThat(ReflectionTestUtils.getField(connector, "extensionJson")).isSameAs(json);
        }
    }
}
