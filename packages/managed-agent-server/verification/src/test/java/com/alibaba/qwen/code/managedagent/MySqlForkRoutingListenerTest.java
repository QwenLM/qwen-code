package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;

class MySqlForkRoutingListenerTest {
    private static final List<String> PROPERTIES = List.of("qwen.mysql.forkCount", "qwen.mysql.forkNumber",
            "mysql.url", "mysql.url.1", "mysql.url.2");
    private final Map<String, String> originalProperties = new HashMap<>();

    @BeforeEach
    void saveProperties() {
        for (String property : PROPERTIES) {
            originalProperties.put(property, System.getProperty(property));
            System.clearProperty(property);
        }
        System.setProperty("mysql.url", "jdbc:mysql://legacy/disposable");
    }

    @AfterEach
    void restoreProperties() {
        originalProperties.forEach((property, value) -> {
            if (value == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, value);
            }
        });
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = "1")
    void leavesOrdinaryAndSingleForkLaunchersUnchanged(String forks) {
        if (forks != null) {
            System.setProperty("qwen.mysql.forkCount", forks);
        }
        try (var session = LauncherFactory.openSession()) {
            assertThat(session.getLauncher()).isNotNull();
            assertThat(System.getProperty("mysql.url")).isEqualTo("jdbc:mysql://legacy/disposable");
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void routesBeforePerClassConstructionAndSpringInitialization(int fork) {
        System.setProperty("qwen.mysql.forkCount", "2");
        System.setProperty("qwen.mysql.forkNumber", "0" + fork);
        System.setProperty("mysql.url.1", "jdbc:mysql://127.0.0.1:33061/first");
        System.setProperty("mysql.url.2", "jdbc:mysql://127.0.0.1:33062/second");
        try (var session = LauncherFactory.openSession()) {
            assertThat(System.getProperty("mysql.url")).isEqualTo(selectedUrl());
            var request = LauncherDiscoveryRequestBuilder.request().selectors(selectClass(SpringProbe.class)).build();
            var summary = new SummaryGeneratingListener();
            session.getLauncher().execute(request, summary);
            assertThat(summary.getSummary().getFailures()).isEmpty();
            assertThat(summary.getSummary().getTestsSucceededCount()).isEqualTo(2);
        }
    }

    @Test
    void refusesAMissingMappingInsteadOfUsingTheLegacyUrl() {
        System.setProperty("qwen.mysql.forkCount", "2");
        System.setProperty("qwen.mysql.forkNumber", "2");
        System.setProperty("mysql.url.1", "jdbc:mysql://127.0.0.1:33061/first");
        assertThatThrownBy(LauncherFactory::openSession).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mysql.url.2");
        assertThat(System.getProperty("mysql.url")).isEqualTo("jdbc:mysql://legacy/disposable");
    }

    @Test
    void refusesANonMySqlMapping() {
        System.setProperty("qwen.mysql.forkCount", "2");
        System.setProperty("qwen.mysql.forkNumber", "1");
        System.setProperty("mysql.url.1", "jdbc:h2:mem:shared");
        assertThatThrownBy(LauncherFactory::openSession).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mysql.url.1");
    }

    @Test
    void refusesAForkOutsideTheConfiguredCount() {
        System.setProperty("qwen.mysql.forkCount", "2");
        System.setProperty("qwen.mysql.forkNumber", "3");
        assertThatThrownBy(LauncherFactory::openSession).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("qwen.mysql.forkNumber");
    }

    private static String selectedUrl() {
        return System.getProperty("mysql.url." + Integer.parseInt(System.getProperty("qwen.mysql.forkNumber")));
    }

    @SpringJUnitConfig(ProbeConfiguration.class)
    @TestInstance(TestInstance.Lifecycle.PER_CLASS)
    @DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
    static class SpringProbe {
        private final String constructorUrl = System.getProperty("mysql.url");
        @Autowired private String routedUrl;

        @DynamicPropertySource
        static void properties(DynamicPropertyRegistry registry) {
            String url = System.getProperty("mysql.url");
            registry.add("test.mysql.url", () -> url);
        }

        @BeforeAll
        void verifyStartupOrder() {
            assertThat(constructorUrl).isEqualTo(selectedUrl());
            assertThat(routedUrl).isEqualTo(selectedUrl());
        }

        @Test
        void usesTheSelectedDatabase() {
            assertThat(routedUrl).isEqualTo(selectedUrl());
        }

        @Nested
        class NestedProbe {
            @Test
            void keepsTheSelectedDatabase() {
                assertThat(System.getProperty("mysql.url")).isEqualTo(selectedUrl());
                assertThat(routedUrl).isEqualTo(selectedUrl());
            }
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class ProbeConfiguration {
        @Bean
        String routedUrl(Environment environment) {
            return environment.getRequiredProperty("test.mysql.url");
        }
    }
}
