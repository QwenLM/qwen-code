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
        // future fields too. getDeclaredClasses() sees direct members only,
        // so walk the graph transitively, starting at the outer class
        // itself (a top-level Duration, or one on a depth-2 type such as
        // RuntimeBroker.WorkspaceMount, must not slip the sweep).
        var pending = new java.util.ArrayDeque<Class<?>>();
        var seen = java.util.Collections.newSetFromMap(
                new java.util.IdentityHashMap<Class<?>, Boolean>());
        pending.add(ManagedAgentProperties.class);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!seen.add(current)) {
                continue;
            }
            for (java.lang.reflect.Field field : current
                    .getDeclaredFields()) {
                if (field.getType() == java.time.Duration.class) {
                    assertThat(field.getAnnotation(
                            org.springframework.boot.convert.DurationUnit.class))
                            .as(current.getSimpleName() + "."
                                    + field.getName())
                            .isNotNull();
                }
            }
            pending.addAll(java.util.List.of(current.getDeclaredClasses()));
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
    void materializeIntervalDrivesTheScheduledCadence() {
        // The typed field is the cadence's only driving source:
        // ManagedArtifactConfiguration.messageMaterializerTask schedules
        // the pass with it on the dedicated single-thread scheduler, and a
        // property-less boot keeps the shipped 100 ms default.
        assertThat(new ManagedAgentProperties().getEvents()
                .getMaterializeInterval())
                .isEqualTo(java.time.Duration.ofMillis(100));
        assertThat(com.alibaba.qwen.code.managedagent.service
                .MessageMaterializer.class.getMethods())
                .noneMatch(method -> method.isAnnotationPresent(
                        org.springframework.scheduling.annotation.Scheduled.class));
    }

    @Test
    void theThreeScanDelaySchedulesShareOneFallback() {
        // The Dispatch comment claims the three sites read the identical
        // "${...scan-delay:1s}" placeholder; only this pin keeps the claim
        // true when one fallback is retuned without the others.
        String expected = "${qwen.managed-agent.dispatch.scan-delay:1s}";
        assertThat(scanDelayFallback(
                com.alibaba.qwen.code.managedagent.service
                        .ActionResponseCoordinator.class)).isEqualTo(expected);
        assertThat(scanDelayFallback(
                com.alibaba.qwen.code.managedagent.service
                        .HarnessCoordinator.class)).isEqualTo(expected);
        assertThat(scanDelayFallback(
                com.alibaba.qwen.code.managedagent.service
                        .SessionLifecycleCoordinator.class))
                .isEqualTo(expected);
    }

    private static String scanDelayFallback(Class<?> coordinator) {
        return java.util.Arrays.stream(coordinator.getDeclaredMethods())
                .map(method -> method.getAnnotation(
                        org.springframework.scheduling.annotation
                                .Scheduled.class))
                .filter(java.util.Objects::nonNull)
                .map(org.springframework.scheduling.annotation.Scheduled
                        ::fixedDelayString)
                .filter(value -> value.contains("dispatch.scan-delay"))
                .findFirst().orElseThrow();
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
    void relaxationDefaultsMatchTheShippedConfiguration() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        assertThat(properties.getEvents().getReadGrantRecheckInterval())
                .isEqualTo(java.time.Duration.ofSeconds(5));
        assertThat(properties.getArtifacts().getReadRevalidationInterval())
                .isEqualTo(java.time.Duration.ofSeconds(5));
        assertThat(properties.getToolPublication()
                .isJournalHeadAuthorization()).isFalse();
        // ... and the shipped application.yml mirrors the same values.
        var yaml = new org.springframework.boot.env.YamlPropertySourceLoader()
                .load("application.yml",
                        new org.springframework.core.io.ClassPathResource(
                                "application.yml"));
        // The flattened keys must exist: a renamed or dropped key would
        // bind nothing, and the value assertions below would pass on the
        // Java defaults.
        assertThat(yaml).anySatisfy(source -> {
            assertThat(source.containsProperty("qwen.managed-agent.events"
                    + ".read-grant-recheck-interval")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.artifacts"
                    + ".read-revalidation-interval")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent"
                    + ".tool-publication.journal-head-authorization"))
                    .isTrue();
        });
        new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class)
                .withInitializer(ctx -> {
                    // The yaml's ${QWEN_*} placeholders must resolve to
                    // their shipped defaults regardless of the ambient shell.
                    java.util.Map<String, Object> ambient =
                            new java.util.LinkedHashMap<>(System.getenv());
                    ambient.keySet().removeIf(name -> name
                            .startsWith("QWEN_MANAGED_AGENT_"));
                    ctx.getEnvironment().getPropertySources().replace(
                            "systemEnvironment",
                            new org.springframework.core.env.MapPropertySource(
                                    "systemEnvironment", ambient));
                    yaml.forEach(ctx.getEnvironment().getPropertySources()
                            ::addLast);
                })
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    ManagedAgentProperties bound = started
                            .getBean(ManagedAgentProperties.class);
                    assertThat(bound.getEvents().getReadGrantRecheckInterval())
                            .isEqualTo(java.time.Duration.ofSeconds(5));
                    assertThat(bound.getArtifacts()
                            .getReadRevalidationInterval())
                            .isEqualTo(java.time.Duration.ofSeconds(5));
                    assertThat(bound.getToolPublication()
                            .isJournalHeadAuthorization()).isFalse();
                });
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
