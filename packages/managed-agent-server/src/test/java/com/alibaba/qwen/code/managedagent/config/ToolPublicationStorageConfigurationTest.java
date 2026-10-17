package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.store.AliyunToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationCollector;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.aliyun.oss.OSS;
import com.aliyun.oss.model.AccessControlList;
import com.aliyun.oss.model.CannedAccessControlList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.support.AbstractBeanDefinition;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ToolPublicationStorageConfigurationTest {
    private static final String PREFIX = "qwen.managed-agent.tool-publication.";

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AliyunToolPublicationStorageAutoConfiguration.class))
            .withUserConfiguration(PropertiesConfiguration.class, ToolPublicationConfiguration.class)
            .withBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class))
            .withBean(PlatformTransactionManager.class, () -> mock(PlatformTransactionManager.class))
            .withBean(ManagedSessionStore.class, () -> mock(ManagedSessionStore.class))
            .withBean(WriterCredentialPolicy.class, WriterCredentialPolicy::unbound)
            .withBean(ToolExecutionRepository.class, () -> mock(ToolExecutionRepository.class))
            .withBean(RuntimeBindingRepository.class, () -> mock(RuntimeBindingRepository.class))
            .withBean(ThreadPoolTaskSchedulerBuilder.class, ThreadPoolTaskSchedulerBuilder::new)
            .withPropertyValues(PREFIX + "service-base-url=https://test.invalid",
                    PREFIX + "execution-bytes=1048576", PREFIX + "session-bytes=1073741824",
                    PREFIX + "tenant-bytes=1073741824", PREFIX + "active-captures=4",
                    PREFIX + "entry-concurrency=4", PREFIX + "operation-timeout=10s",
                    PREFIX + "claim-timeout=5s", PREFIX + "verification-bytes-per-second=1048576",
                    PREFIX + "max-verification-timeout=20m");

    @Test
    void bootDiscoversTheDefaultAdapter() {
        assertThat(ImportCandidates.load(AutoConfiguration.class, getClass().getClassLoader()))
                .contains(AliyunToolPublicationStorageAutoConfiguration.class.getName());
    }

    @Test
    void disabledPublicationDoesNotCreateStorage() {
        runner.run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(OSS.class)
                .doesNotHaveBean(ToolPublicationObjectStore.class).doesNotHaveBean(ToolPublicationDataStore.class));
    }

    @Test
    void maintenanceContextsDoNotInitializePublicationStorage() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(AliyunToolPublicationStorageAutoConfiguration.class))
                .withUserConfiguration(PropertiesConfiguration.class)
                .withPropertyValues(PREFIX + "enabled=true")
                .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(OSS.class)
                        .doesNotHaveBean(ToolPublicationObjectStore.class));
    }

    @Test
    void anApplicationStoreReplacesOssWithoutAnyOssSettings() {
        runner.withUserConfiguration(CustomStorageConfiguration.class)
                .withPropertyValues(PREFIX + "enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed().hasSingleBean(ToolPublicationObjectStore.class)
                            .doesNotHaveBean(OSS.class).doesNotHaveBean(AliyunToolPublicationStorageAutoConfiguration.class);
                    var objects = context.getBean("alternativeStorage", ToolPublicationObjectStore.class);
                    assertThat(ReflectionTestUtils.getField(context.getBean(ToolPublicationDataStore.class), "objects"))
                            .isSameAs(objects);
                    assertThat(ReflectionTestUtils.getField(context.getBean(ToolPublicationCollector.class), "objects"))
                            .isSameAs(objects);
                });
    }

    @ParameterizedTest
    @CsvSource({"service-base-url,service URL", "execution-bytes,execution byte capacity",
            "operation-timeout,deadlines are required"})
    void aCustomStoreStillRequiresCommonPublicationSettings(String missing, String failure) {
        runner.withUserConfiguration(CustomStorageConfiguration.class)
                .withPropertyValues(PREFIX + "enabled=true", PREFIX + missing + "=")
                .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining(failure));
    }

    @Test
    void theDefaultAdapterStillRequiresOssConfiguration() {
        runner.withPropertyValues(PREFIX + "enabled=true")
                .run(context -> assertThat(context).hasFailed()
                        .getFailure().hasRootCauseInstanceOf(IllegalStateException.class)
                        .hasStackTraceContaining("OSS endpoint"));
    }

    @Test
    void theDefaultAdapterOwnsAndClosesItsOssClient() {
        var client = mock(OSS.class);
        var acl = new AccessControlList();
        acl.setCannedACL(CannedAccessControlList.Private);
        when(client.getBucketAcl("private-test-bucket")).thenReturn(acl);
        runner.withPropertyValues(PREFIX + "enabled=true", PREFIX + "oss-bucket=private-test-bucket")
                .withBean("unrelatedOss", OSS.class, () -> mock(OSS.class))
                .withBean(BeanFactoryPostProcessor.class, () -> beanFactory ->
                        ((AbstractBeanDefinition) beanFactory.getBeanDefinition("toolPublicationOss"))
                                .setInstanceSupplier(() -> client))
                .run(context -> {
                    assertThat(context).hasNotFailed().hasSingleBean(ToolPublicationObjectStore.class);
                    assertThat(context.getBeansOfType(OSS.class)).hasSize(2);
                    assertThat(context.getBean("toolPublicationOss", OSS.class)).isSameAs(client);
                    assertThat(context.getBean(ToolPublicationObjectStore.class))
                            .isInstanceOf(AliyunToolPublicationObjectStore.class);
                });
        verify(client).shutdown();
    }

    @TestConfiguration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class PropertiesConfiguration {}

    @TestConfiguration(proxyBeanMethods = false)
    static class CustomStorageConfiguration {
        @Bean
        ToolPublicationObjectStore alternativeStorage() {
            return mock(ToolPublicationObjectStore.class);
        }
    }
}
