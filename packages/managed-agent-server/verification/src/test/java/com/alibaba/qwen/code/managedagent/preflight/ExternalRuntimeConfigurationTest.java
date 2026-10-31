package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeProvisioner;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExternalRuntimeConfigurationTest {
    @Test
    void bindsScratchEnvironmentSettingsAndPreservesRequestKind() {
        var properties = scratchProperties();
        var broker = properties.getRuntimeBroker();
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.startupValidationCheck(properties).status());
        assertFalse(ManagedAgentPreflight.brokerChecks(properties).stream()
                .anyMatch(check -> check.status() == ManagedAgentPreflight.Status.FAIL));
        assertEquals(Duration.ofSeconds(7), broker.getExternalRequestTimeout());
        assertEquals(Duration.ofSeconds(90), broker.getExternalStartupTimeout());
        assertEquals("placement-service", broker.getExternalProviderId());
        assertEquals("http://provider.invalid/api", broker.getExternalProviderUrl());
        assertEquals("provider-token-for-tests", broker.getExternalProviderToken());
        try (var provisioner = new ExternalRuntimeProvisioner(new ExternalHttpRuntimeClient(
                URI.create(broker.getExternalProviderUrl()), broker.getExternalProviderToken(),
                broker.getExternalRequestTimeout()), broker.getExternalProviderId(),
                broker.getExternalStartupTimeout())) {
            var request = provisioner.createRequest(new RuntimeScope("tenant", broker.getWorkspaceId(),
                    broker.getWorkspaceGeneration(), broker.getWorkspaceCwd(),
                    "sha256:" + "a".repeat(64), broker.getIsolationClass()), "session");
            assertEquals("external-scratch", broker.getProvisioner());
            assertEquals(broker.getProvisioner(), request.getProvisionerKind());
            assertFalse(request.isManagedContext());
        }
    }

    @Test
    void rejectsManagedWorkspaceFeaturesDuringStartupValidation() {
        List<Consumer<ManagedAgentProperties>> configurations = List.of(
                properties -> properties.getHarness().setWorkspaceFilesEnabled(true),
                properties -> properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                        new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/data"))),
                properties -> properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true));
        for (var configure : configurations) {
            var properties = scratchProperties();
            configure.accept(properties);
            var error = assertThrows(IllegalStateException.class, properties::validateForPreflight);
            assertTrue(error.getMessage().contains("scratch Sessions only"));
        }
    }

    @Test
    void rejectsAMalformedHarnessCapabilityDigestDuringStartupValidation() {
        var properties = scratchProperties();
        // Every external scope carries this digest (EmbeddedRuntimeBroker
        // resolves it from the Harness properties); a malformed one only
        // fails later, per warm, as a provider-blaming permanent 409.
        properties.getHarness().setCapabilityDigest("SHA256:" + "A".repeat(64));
        var error = assertThrows(IllegalStateException.class, properties::validateForPreflight);
        assertTrue(error.getMessage().contains("capability digest"), error.getMessage());
    }

    @Test
    void acceptsABlankHarnessCapabilityDigestDuringStartupValidation() {
        // The digest is still optional at this gate: the Broker's
        // construction refuses a blank one with its own named message.
        var properties = scratchProperties();
        assertEquals("", properties.getHarness().getCapabilityDigest());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.startupValidationCheck(properties).status());
    }

    @Test
    void rejectsTheShippedTemplateProviderTokenDuringStartupValidation() {
        var properties = scratchProperties();
        // Matches the Harness token precedent: the placeholder satisfies the
        // token format, so it needs its own refusal to not boot as a live
        // bearer credential anyone can read in the distribution.
        properties.getRuntimeBroker().setExternalProviderToken("replace-with-a-long-random-token");
        var error = assertThrows(IllegalStateException.class, properties::validateForPreflight);
        assertTrue(error.getMessage().contains("template placeholder"), error.getMessage());
        assertThrows(IllegalArgumentException.class, () -> new ExternalHttpRuntimeClient(
                URI.create("https://provider.invalid/"), "replace-with-a-long-random-token", Duration.ofSeconds(1)));
    }

    @Test
    void preflightDoesNotRequireWorkerCwdOrLocalStateDirectory(@TempDir Path directory) {
        Path missing = directory.resolve("worker-only");
        assertFalse(Files.exists(missing));
        var checks = ManagedAgentPreflight.checks(new String[] {
                "--qwen.managed-agent.runtime-broker.provisioner=external-scratch",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + missing,
                "--qwen.managed-agent.runtime-broker.state-directory=",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.workspace-id=scratch",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.external-provider-url=http://provider.invalid/api",
                "--qwen.managed-agent.runtime-broker.external-provider-token=provider-token-for-tests",
                "--spring.datasource.url=jdbc:unsupported:preflight",
                "--server.port=0"});
        var validation = checks.stream().filter(check -> check.name().equals("validation"))
                .findFirst().orElseThrow();
        assertEquals(ManagedAgentPreflight.Status.PASS, validation.status());
        var workspace = checks.stream().filter(check -> check.name().equals("workspace"))
                .findFirst().orElseThrow();
        assertEquals(ManagedAgentPreflight.Status.SKIP, workspace.status());
        assertFalse(Files.exists(missing));
        assertFalse(checks.stream().anyMatch(check -> check.name().equals("broker-state")));
    }

    private static ManagedAgentProperties properties(String provisioner) {
        var environment = new MockEnvironment()
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED", "true")
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER", provisioner)
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN", "broker-token-for-tests")
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID", "key-1")
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY",
                        java.util.Base64.getEncoder().encodeToString(new byte[32]))
                .withProperty("QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY", "false")
                .withProperty("QWEN_MANAGED_AGENT_WORKSPACE_ID", "scratch")
                .withProperty("QWEN_MANAGED_AGENT_WORKSPACE_CWD", "/worker/scratch")
                .withProperty("QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_URL", "http://provider.invalid/api")
                .withProperty("QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_TOKEN", "provider-token-for-tests")
                .withProperty("QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_ID", "placement-service")
                .withProperty("QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_REQUEST_TIMEOUT", "7")
                .withProperty("QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_STARTUP_TIMEOUT", "90");
        var notes = new ArrayList<ManagedAgentPreflight.Check>();
        ManagedAgentPreflight.loadConfiguration(environment, List.of(), notes);
        var properties = ManagedAgentPreflight.bind(environment, notes);
        assertTrue(notes.isEmpty(), notes.toString());
        return properties;
    }

    private static ManagedAgentPreflight.Check brokerCheck(ManagedAgentProperties properties) {
        return ManagedAgentPreflight.brokerChecks(properties).stream()
                .filter(check -> check.name().equals("broker"))
                .findFirst()
                .orElseThrow();
    }

    @Test
    void bindsTheExternalWorkspaceKindWithoutAdmittingHostedWorkspaceFeatures() {
        var properties = properties(
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE);
        assertEquals(
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE,
                properties.getRuntimeBroker().getProvisioner());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.startupValidationCheck(properties).status());
        var broker = brokerCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.PASS, broker.status(), broker.detail());
        assertTrue(broker.detail().startsWith("external-workspace configuration accepted"),
                broker.detail());
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var error = assertThrows(IllegalStateException.class, properties::validateForPreflight);
        assertTrue(error.getMessage().contains("Hosted Workspace files require"), error.getMessage());
    }

    @Test
    void filesOnlyExternalConfigurationRequiresCompleteServicesWithoutLocalMountFallback() {
        var properties = properties("external-workspace");
        properties.getHarness().setEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        assertTrue(properties.isExternalWorkspaceFilesConfigured());
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight.toolPathCheck(properties).status());
        properties.validateForPreflight();
        List<Consumer<ManagedAgentProperties>> forbidden = List.of(
                p -> p.getHarness().setEnabled(false), p -> p.getSessionStore().setEnabled(false),
                p -> p.getRuntimeBroker().setEnabled(false), p -> p.getHarness().setWorkspaceShellEnabled(true),
                p -> p.getManagedExtensions().setEnabled(true), p -> p.getRuntimeBroker().setChildWorkspacesEnabled(true),
                p -> p.getRuntimeBroker().setWorkspaceMounts(List.of(
                        new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/not-mounted"))),
                p -> p.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true));
        for (var configure : forbidden) {
            var invalid = properties("external-workspace");
            invalid.getHarness().setEnabled(true);
            invalid.getSessionStore().setEnabled(true);
            invalid.getHarness().setWorkspaceFilesEnabled(true);
            configure.accept(invalid);
            assertFalse(invalid.isExternalWorkspaceFilesConfigured());
            assertThrows(IllegalStateException.class, invalid::validateForPreflight);
        }
    }

    @Test
    void theOperatorVisibleTextOfBothExternalKindsIsPinned() {
        var workspace = brokerCheck(properties(
                com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE));
        assertEquals("external-workspace configuration accepted; provider reachability,"
                + " worker attestation and storage registration are checked on first use",
                workspace.detail());
        var scratch = brokerCheck(scratchProperties());
        assertEquals("external-scratch configuration accepted; provider reachability,"
                + " worker attestation and storage registration are checked on first use",
                scratch.detail());
        // Configurable is not usable: the prerequisite WARN must say so.
        var warn = ManagedAgentPreflight.brokerChecks(properties(
                        com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE))
                .stream().filter(check -> check.name().equals("external-prerequisite"))
                .findFirst().orElseThrow();
        assertEquals(ManagedAgentPreflight.Status.WARN, warn.status());
        assertTrue(warn.detail().contains("files are disabled or incompletely configured"), warn.detail());
        assertTrue(warn.detail().contains("new Hosted files Sessions fail closed"), warn.detail());
        assertTrue(ManagedAgentPreflight.brokerChecks(scratchProperties()).stream()
                        .noneMatch(check -> check.name().equals("external-prerequisite")),
                "the scratch profile is not a prerequisite");
    }

    @Test
    void anUnknownExternalKindStillFailsClosed() {
        var broker = brokerCheck(properties("external-workspace-typo"));
        assertEquals(ManagedAgentPreflight.Status.FAIL, broker.status());
        assertTrue(broker.detail().contains("unknown provisioner external-workspace-typo"),
                broker.detail());
        assertTrue(broker.fix().contains("external-scratch"), broker.fix());
        assertTrue(broker.fix().contains("external-workspace"), broker.fix());
    }

    @Test
    void theShippedScratchRefusalWordingIsUnchanged() {
        var properties = scratchProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var error = assertThrows(IllegalStateException.class, properties::validateForPreflight);
        assertTrue(error.getMessage().contains("scratch Sessions only"), error.getMessage());
    }

    private static ManagedAgentProperties scratchProperties() {
        return properties(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_SCRATCH);
    }
}
