package com.alibaba.qwen.code.managedagent.harness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.CreateHarnessSession;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class QwenHostedHarnessConnectorTest {
    private static final String SESSION_ID =
            "33333333-3333-4333-8333-333333333333";
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";

    @Test
    void loadsAnExistingSessionWithoutCreatingIt() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", SESSION_ID, true);

        assertThat(attachment.bootId()).isEqualTo(BOOT_ID);
        verify(client).loadSession(any(LoadHarnessSession.class));
        verify(client, never()).createSession(any(CreateHarnessSession.class));
    }

    @Test
    void loadsAnExistingAuthorityAfterCreateConflicts() {
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities =
                mock(HostedHarnessCapabilities.class);
        HarnessSessionRef session = mock(HarnessSessionRef.class);
        DaemonHttpException conflict = mock(DaemonHttpException.class);
        when(conflict.getStatusCode()).thenReturn(409);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.loadSession(any(LoadHarnessSession.class)))
                .thenReturn(session);
        when(client.createSession(any(CreateHarnessSession.class)))
                .thenThrow(conflict);
        when(session.getHarnessBootId()).thenReturn(BOOT_ID);
        QwenHostedHarnessConnector connector = connector(client);

        HarnessConnector.Attachment attachment = connector.createOrLoad(
                "tenant-a", SESSION_ID, false);

        assertThat(attachment.bootId()).isEqualTo(BOOT_ID);
        verify(client).loadSession(any(LoadHarnessSession.class));
        verify(client).createSession(any(CreateHarnessSession.class));
    }

    private static QwenHostedHarnessConnector connector(
            HostedHarnessClient client) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest("sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("https://store.example");
        properties.getSessionStore().setWorkspaceId("workspace-a");
        properties.getSessionStore().setWriterLeaseDuration(
                Duration.ofSeconds(60));
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties);
        ReflectionTestUtils.setField(connector, "client", client);
        return connector;
    }
}
