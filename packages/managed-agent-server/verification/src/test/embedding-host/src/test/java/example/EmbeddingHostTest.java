package example;

import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

class EmbeddingHostTest {
    @Test
    void dependencyAloneStartsNoManagedResources() {
        var application = new SpringApplication(Host.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        try (var context = application.run()) {
            assertThat(context.getBeansOfType(ManagedAgentService.class)).isEmpty();
            assertThat(context.getBeansOfType(DataSource.class)).isEmpty();
            assertThat(context.containsBean("managedAgentExecutor")).isFalse();
            assertThat(org.springframework.util.ClassUtils.isPresent(
                    "org.springframework.boot.actuate.endpoint.annotation.Endpoint", context.getClassLoader())).isFalse();
            assertThat(java.util.ServiceLoader.load(com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory.class)
                    .stream()).isEmpty();
            for (String provider : java.util.List.of("local.LocalProcessRuntimeProvisioner", "external.ExternalRuntimeProvisioner",
                    "ssh.SshRuntimeProvisioner", "kubernetes.ResidentWorkspaceProvisioner", "staticruntime.StaticRuntimeProvisioner")) {
                assertThat(org.springframework.util.ClassUtils.isPresent(
                        "com.alibaba.qwen.code.runtimebroker.provisioning." + provider, context.getClassLoader())).isFalse();
            }
            assertThat(context.getEnvironment().getProperty("spring.datasource.url")).isNull();
        }
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    static class Host {
    }
}
