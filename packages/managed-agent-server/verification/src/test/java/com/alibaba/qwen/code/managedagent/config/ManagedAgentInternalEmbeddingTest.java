package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ManagedAgentInternalEmbeddingTest {
    private WebApplicationContextRunner runner() {
        return new WebApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JacksonAutoConfiguration.class,
                        TaskSchedulingAutoConfiguration.class, WebMvcAutoConfiguration.class,
                        org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration.class))
                .withUserConfiguration(ManagedAgentConfiguration.class, ManagedAgentInternalConfiguration.class, Host.class)
                .withPropertyValues("qwen.managed-agent.datasource.url=jdbc:h2:mem:internal-" + UUID.randomUUID()
                                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
                        "qwen.managed-agent.session-store.enabled=true",
                        "spring.jackson.property-naming-strategy=SNAKE_CASE");
    }

    @Test
    void refusesUnboundCallbacks() {
        runner().run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("Embedded callbacks require");
        });
    }

    @Test
    void authenticatesInternalWriterAndPreservesHostSerializationAndAdvice() {
        runner().withPropertyValues("qwen.managed-agent.session-store.binding-key=" + "k".repeat(32)).run(context -> {
            assertThat(context).hasNotFailed();
            var mvc = MockMvcBuilders.webAppContextSetup(context)
                    .addFilters(context.getBean(TenantContextFilter.class)).build();
            mvc.perform(get("/host")).andExpect(status().isOk()).andExpect(jsonPath("$.host_value").value("host"));
            String endpoint = "/internal/managed-session-store/v1/sessions/session/writers:acquire";
            String body = "{\"workspaceId\":\"workspace\",\"writerId\":\"writer\",\"leaseMillis\":30000}";
            mvc.perform(post(endpoint).header("X-Qwen-Tenant-Id", "tenant")
                            .header("X-Qwen-Managed-Writer-Token", "forged").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().is4xxClientError());
            String token = context.getBean(WriterCredentialPolicy.class).issue("tenant", "workspace", "session");
            mvc.perform(post(endpoint).header("X-Qwen-Tenant-Id", "tenant")
                            .header("X-Qwen-Managed-Writer-Token", token).contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.writerGeneration").exists());
            assertThat(context.containsBean("managedAgentController")).isFalse();
        });
    }

    @Test
    void hostPublicRouteMustRemainAccessible() {
        runner().withPropertyValues("qwen.managed-agent.session-store.binding-key=" + "k".repeat(32)).run(context -> {
            var mvc = MockMvcBuilders.webAppContextSetup(context)
                    .addFilters(context.getBean(TenantContextFilter.class)).build();
            mvc.perform(get("/v1/agents")).andExpect(status().isOk());
        });
    }

    record HostResponse(String hostValue) { }

    @Configuration(proxyBeanMethods = false)
    static class Host {
        @Bean
        HostController hostController() {
            return new HostController();
        }
    }

    @RestController
    static class HostController {
        @GetMapping({"/host", "/v1/agents"})
        HostResponse response() {
            return new HostResponse("host");
        }
    }
}
