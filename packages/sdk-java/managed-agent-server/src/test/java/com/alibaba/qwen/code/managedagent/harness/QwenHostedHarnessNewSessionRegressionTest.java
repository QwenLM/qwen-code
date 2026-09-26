package com.alibaba.qwen.code.managedagent.harness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class QwenHostedHarnessNewSessionRegressionTest {
    @Test
    void createsNewDurableSessionWithoutFirstLoadingIt() {
        String bootId = "11111111-1111-4111-8111-111111111111";
        String sessionId = "33333333-3333-4333-8333-333333333333";
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(bootId);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenThrow(new AssertionError("A new durable session must not"
                        + " be loaded before creation"));
        when(client.createSession(any(CreateHarnessSession.class)))
                .thenReturn(session);
        when(session.getHarnessBootId()).thenReturn(bootId);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest("sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("https://store.example");
        properties.getSessionStore().setWorkspaceId("workspace-a");
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties);
        ReflectionTestUtils.setField(connector, "client", client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", sessionId, false);

        assertThat(attachment.bootId()).isEqualTo(bootId);
        verify(client).createSession(any(CreateHarnessSession.class));
        verify(client, never()).loadSession(any(LoadHarnessSession.class));
    }
}
