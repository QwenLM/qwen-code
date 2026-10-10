package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ToolPublicationConfiguration;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

class ToolPublicationConfigurationTest {
    @Test
    void disabledPublicationHasNoImplicitVerificationBudget() {
        var settings = new ManagedAgentProperties().getToolPublication();
        assertThat(settings.isEnabled()).isFalse();
        assertThat(settings.getVerificationBytesPerSecond()).isNull();
        assertThat(settings.getMaxVerificationTimeout()).isNull();
    }

    @Test
    void requiresExplicitBudgetAndRejectsCapacityThatCannotFit() {
        var properties = new ManagedAgentProperties();
        var settings = properties.getToolPublication();
        settings.setOperationTimeout(Duration.ofSeconds(10));
        settings.setClaimTimeout(Duration.ofSeconds(5));
        settings.setExecutionBytes(1024L * 1024 * 1024);
        assertThatThrownBy(() -> data(properties)).hasMessageContaining("deadlines are required");
        settings.setMaxVerificationTimeout(Duration.ofMinutes(20));
        assertThatThrownBy(() -> data(properties)).hasMessageContaining("throughput floor");
        settings.setVerificationBytesPerSecond(1024L);
        assertThatThrownBy(() -> data(properties)).hasMessageContaining("exceeds its configured budget");
        settings.setVerificationBytesPerSecond(1024L * 1024);
        assertThat(data(properties)).isNotNull();
        settings.setMaxVerificationTimeout(Duration.ofMinutes(26));
        assertThatThrownBy(() -> data(properties)).hasMessageContaining("Invalid publication verification budget");
    }

    @Test
    void roundsWorkUpAndNeverClampsAnInsufficientBudget() {
        var budget = new ToolPublicationDataStore.VerificationBudget(1024, Duration.ofSeconds(5));
        assertThat(budget.timeout(Duration.ofSeconds(1), 0)).isEqualTo(Duration.ofSeconds(1));
        assertThat(budget.timeout(Duration.ofSeconds(1), 1025)).isEqualTo(Duration.ofSeconds(3));
        assertThatThrownBy(() -> budget.timeout(Duration.ofSeconds(1), 4097))
                .hasMessageContaining("exceeds its configured budget");
        assertThatThrownBy(() -> budget.timeout(Duration.ofSeconds(1), -1))
                .hasMessageContaining("Invalid publication verification size");
    }

    @Test
    void sharedOssFactoryPreservesEndpointSigningAndRetryPolicy() {
        var properties = new ManagedAgentProperties();
        var settings = properties.getToolPublication();
        settings.setOssRegion("cn-hangzhou");
        settings.setOssEndpoint("https://oss-cn-hangzhou.aliyuncs.com");
        settings.setOssBucket("private-test-bucket");
        settings.setServiceBaseUrl("https://test.invalid");
        var credentials = new com.aliyun.oss.common.auth.DefaultCredentialProvider(
                new com.aliyun.oss.common.auth.DefaultCredentials("test", "test"));
        var client = (com.aliyun.oss.OSSClient) ToolPublicationConfiguration.buildOss(properties, credentials);
        try {
            assertThat(client.getCredentialsProvider()).isSameAs(credentials);
            assertThat(client.getClientConfiguration().getSignatureVersion())
                    .isEqualTo(com.aliyun.oss.common.comm.SignVersion.V4);
            assertThat(client.getClientConfiguration().getMaxErrorRetry()).isEqualTo(1);
            var request = new com.aliyun.oss.common.comm.RequestMessage("private-test-bucket", "key");
            request.setMethod(com.aliyun.oss.HttpMethod.PUT);
            var response = new com.aliyun.oss.common.comm.ResponseMessage(
                    new com.aliyun.oss.common.comm.ServiceClient.Request());
            response.setStatusCode(503);
            assertThat(client.getClientConfiguration().getRetryStrategy().shouldRetry(
                    new com.aliyun.oss.OSSException("write failure"), request, response, 0)).isFalse();
        } finally { client.shutdown(); }
        settings.setOssEndpoint("http://oss-cn-hangzhou.aliyuncs.com");
        assertThatThrownBy(() -> ToolPublicationConfiguration.buildOss(properties, credentials))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("regional HTTPS");
    }

    @Test
    void theJournalHeadAuthorizationFlagReachesTheStore() {
        var configuration = new ToolPublicationConfiguration();
        var properties = new ManagedAgentProperties();
        var settings = properties.getToolPublication();
        settings.setExecutionBytes(1024L * 1024 * 1024);
        settings.setSessionBytes(1024L * 1024 * 1024);
        settings.setTenantBytes(1024L * 1024 * 1024);
        settings.setActiveCaptures(4L);
        settings.setEntryConcurrency(4);
        assertThat(storeOf(configuration, properties).journalHeadAuthorization())
                .isFalse();
        settings.setJournalHeadAuthorization(true);
        assertThat(storeOf(configuration, properties).journalHeadAuthorization())
                .isTrue();
    }

    private ToolPublicationStore storeOf(ToolPublicationConfiguration configuration,
            ManagedAgentProperties properties) {
        return configuration.toolPublicationStore(mock(JdbcTemplate.class),
                mock(PlatformTransactionManager.class),
                mock(ManagedSessionStore.class),
                mock(com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository.class),
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository.class),
                properties);
    }

    private ToolPublicationDataStore data(ManagedAgentProperties properties) {
        return new ToolPublicationConfiguration().toolPublicationDataStore(mock(JdbcTemplate.class),
                mock(PlatformTransactionManager.class), mock(ToolPublicationStore.class),
                mock(ManagedSessionStore.class), mock(ToolPublicationObjectStore.class), properties);
    }
}
