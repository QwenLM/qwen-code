package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class ManagedAgentPropertiesTest {
    private static final String DURABLE_KEY = "qwen.managed-agent.runtime-broker.durable-local-process";
    private static final String TRUSTED_KEY =
            "qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery";

    @Test
    void applicationYmlBindsTheDurableAndTrustedDefaults() throws java.io.IOException {
        var values = applicationYmlValues();
        // The named contract itself: reverting either fallback flips the
        // binding below red; renaming or typoing either variable shows up here.
        assertThat(values).containsEntry(DURABLE_KEY,
                "${QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:true}");
        assertThat(values).containsEntry(TRUSTED_KEY,
                "${QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY:true}");
        new ApplicationContextRunner()
                .withPropertyValues(
                        DURABLE_KEY + "=" + values.get(DURABLE_KEY),
                        TRUSTED_KEY + "=" + values.get(TRUSTED_KEY))
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    var broker = started.getBean(ManagedAgentProperties.class)
                            .getRuntimeBroker();
                    assertThat(broker.isDurableLocalProcess()).isTrue();
                    assertThat(broker.isTrustedLocalRebootRecovery()).isTrue();
                });
    }

    @Test
    void theDocumentedEnvNamesOverrideTheYmlDefaults() throws java.io.IOException {
        var values = applicationYmlValues();
        var ambient = new java.util.LinkedHashMap<String, Object>();
        System.getenv().forEach((name, value) -> {
            if (!"QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS".equals(name)
                    && !"QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY".equals(name)) {
                ambient.put(name, value);
            }
        });
        ambient.put("QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS", "false");
        ambient.put("QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY", "false");
        new ApplicationContextRunner()
                .withPropertyValues(
                        DURABLE_KEY + "=" + values.get(DURABLE_KEY),
                        TRUSTED_KEY + "=" + values.get(TRUSTED_KEY))
                .withInitializer(ctx -> ctx.getEnvironment().getPropertySources().replace(
                        "systemEnvironment",
                        new org.springframework.core.env.MapPropertySource("systemEnvironment", ambient)))
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    var broker = started.getBean(ManagedAgentProperties.class)
                            .getRuntimeBroker();
                    assertThat(broker.isDurableLocalProcess()).isFalse();
                    assertThat(broker.isTrustedLocalRebootRecovery()).isFalse();
                });
    }

    private static java.util.Map<String, Object> applicationYmlValues() throws java.io.IOException {
        var loaded = new org.springframework.boot.env.YamlPropertySourceLoader().load(
                "application.yml",
                new org.springframework.core.io.ClassPathResource("application.yml"));
        var values = new java.util.LinkedHashMap<String, Object>();
        for (var source : loaded) {
            var enumerable = (org.springframework.core.env.EnumerablePropertySource<?>) source;
            for (String name : enumerable.getPropertyNames()) {
                values.put(name, enumerable.getProperty(name));
            }
        }
        return values;
    }

    @Test
    void everyDurationFieldDeclaresABindingUnit() {
        // A unit-less numeric override binds as milliseconds unless the
        // field declares its unit; this pin keeps the sweep complete for
        // future fields too.
        for (Class<?> nested : ManagedAgentProperties.class
                .getDeclaredClasses()) {
            for (java.lang.reflect.Field field : nested
                    .getDeclaredFields()) {
                if (field.getType() == java.time.Duration.class) {
                    assertThat(field.getAnnotation(
                            org.springframework.boot.convert.DurationUnit.class))
                            .as(nested.getSimpleName() + "."
                                    + field.getName())
                            .isNotNull();
                }
            }
        }
    }

    @Test
    void unitLessNumericOverridesBindInTheDeclaredUnit() {
        // Without @DurationUnit this binds PT0.12S — a 120 ms lease renewed
        // every 20 s invites double execution.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.dispatch.lease-duration=120")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getDispatch().getLeaseDuration())
                            .isEqualTo(java.time.Duration.ofSeconds(120));
                });
    }

    @Test
    void materializeIntervalIsTypedAgainstTheScheduledCadence()
            throws Exception {
        assertThat(new ManagedAgentProperties().getEvents()
                .getMaterializeInterval())
                .isEqualTo(java.time.Duration.ofMillis(100));
        // The annotation fallback is the single source of truth; the typed
        // default must never drift from it.
        var annotation = com.alibaba.qwen.code.managedagent.service
                .MessageMaterializer.class.getMethod("materialize")
                .getAnnotation(
                        org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(annotation.fixedDelayString()).isEqualTo(
                "${qwen.managed-agent.events.materialize-interval:100ms}");
    }

    @Test
    void droppedConfigSurfacesStayDropped() {
        // The kubernetes* and cliEntry blocks had no consumer; they come
        // back only together with their provisioner/invocation.
        assertThat(ManagedAgentProperties.RuntimeBroker.class
                .getDeclaredFields()).noneMatch(field -> field.getName()
                        .startsWith("kubernetes"))
                .noneMatch(field -> field.getName().equals("cliEntry"));
    }

    @Test
    void validatesWorkspaceFilesWhenSpringInitializesTheProperties() {
        ApplicationContextRunner context = new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class);
        context.run(started -> assertThat(started).hasNotFailed());
        ApplicationContextRunner enabled = context.withPropertyValues(
                "qwen.managed-agent.harness.enabled=true",
                "qwen.managed-agent.harness.workspace-files-enabled=true",
                "qwen.managed-agent.session-store.enabled=true",
                "qwen.managed-agent.runtime-broker.enabled=true",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=tenant",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].root=/workspace");
        enabled.run(started -> assertThat(started).hasNotFailed());
        enabled.withPropertyValues("qwen.managed-agent.runtime-broker.isolation-class=workspace")
                .run(started -> assertThat(started).hasFailed()
                        .getFailure().hasRootCauseInstanceOf(IllegalStateException.class)
                        .hasRootCauseMessage("Hosted Workspace files require"
                                + " a supported Harness, Session Store and Session-isolated"
                                + " local-process Broker with Workspace mounts"));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class PropertiesConfiguration {
    }

    @Test
    void fileAdmissionRequiresTheCompleteTrustedLocalDeployment() {
        assertThatCode(() -> new ManagedAgentProperties().validateWorkspaceFiles()).doesNotThrowAnyException();
        List<Consumer<ManagedAgentProperties>> invalid = List.of(
                p -> p.getHarness().setEnabled(false),
                p -> p.getSessionStore().setEnabled(false),
                p -> p.getRuntimeBroker().setEnabled(false),
                p -> p.getRuntimeBroker().setProvisioner("kubernetes"),
                p -> p.getRuntimeBroker().setIsolationClass("workspace"),
                p -> p.getRuntimeBroker().setWorkspaceMounts(List.of()),
                p -> p.getHarness().setApprovalMode("plan"),
                p -> p.getHarness().setApprovalMode("auto"),
                p -> p.getHarness().setApprovalTimeout(java.time.Duration.ofMillis(999)));
        for (Consumer<ManagedAgentProperties> change : invalid) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setEnabled(true);
            properties.getHarness().setWorkspaceFilesEnabled(true);
            properties.getSessionStore().setEnabled(true);
            properties.getRuntimeBroker().setEnabled(true);
            properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/workspace")));
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            properties.getHarness().setApprovalMode("default");
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            properties.getHarness().setApprovalMode("auto-edit");
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            change.accept(properties);
            assertThatThrownBy(properties::validateWorkspaceFiles).isInstanceOf(IllegalStateException.class);
        }
    }
}
