package com.alibaba.qwen.code.runtimebroker.provisioning.external;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.apache.commons.lang3.StringUtils;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

public final class ExternalRuntimeProviderFactory implements RuntimeProviderFactory {
    @Override
    public Set<String> kinds() {
        return Set.of(RuntimeProviderKinds.EXTERNAL_SCRATCH, RuntimeProviderKinds.EXTERNAL_WORKSPACE);
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        var broker = settings.getRuntimeBroker();
        boolean workspace = ExternalRuntimeKinds.isWorkspace(broker.getProvisioner());
        ExternalStorageRegistry storage = workspace ? dependencies.externalStorage() : null;
        ExternalHttpRuntimeClient client = new ExternalHttpRuntimeClient(
                URI.create(broker.getExternalProviderUrl()), broker.getExternalProviderToken(),
                broker.getExternalRequestTimeout());
        return workspace
                ? new ExternalWorkspaceProvisioner(client, storage, broker.getExternalProviderId(),
                        broker.getExternalStartupTimeout())
                : new ExternalRuntimeProvisioner(client, broker.getExternalProviderId(),
                        broker.getExternalStartupTimeout());
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        Check accepted = new Check("broker", Status.PASS,
                settings.getRuntimeBroker().getProvisioner() + " configuration accepted; provider reachability,"
                        + " worker attestation and storage registration are checked on first use", null);
        if (ExternalRuntimeKinds.isWorkspace(settings.getRuntimeBroker().getProvisioner())) {
            List<Check> checks = new ArrayList<>();
            checks.add(accepted);
            checks.add(new Check("external-prerequisite", Status.WARN,
                    settings.isExternalWorkspaceFilesConfigured()
                            ? "External files require exact Harness negotiation and current registration;"
                                    + " original-worker close proof is checked at drain"
                            : "external-workspace files are disabled or incompletely configured;"
                                    + " new Hosted files Sessions fail closed",
                    "keep this profile out of production until files execution and"
                            + " Session close are verified (step 3b/3c)"));
            if (settings.getHarness().isExternalWorkspaceShellEnabled()) {
                checks.add(new Check("external-shell-prerequisite", Status.WARN,
                        settings.isExternalWorkspaceShellConfigured()
                                ? "External foreground Shell is enabled: every command reaches approval,"
                                        + " captured bytes travel through the publication service, and"
                                        + " Session close waits for a drained-stop proof"
                                : "external-workspace Shell is enabled but incompletely configured;"
                                        + " new Hosted Shell Sessions fail closed",
                        "keep this profile out of production until foreground Shell execution,"
                                + " publication drain and in-flight Session close are verified (#15512 slice C)"));
            }
            return checks;
        }
        return List.of(accepted);
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        var runtimeBroker = settings.getRuntimeBroker();
        var harness = settings.getHarness();
        String provisioner = runtimeBroker.getProvisioner();
        if (!ExternalRuntimeKinds.isExternal(provisioner)) {
            return;
        }
        boolean workspace = ExternalRuntimeKinds.isWorkspace(provisioner);
        // The external foreground-Shell profile (#15512 slice C) is admitted
        // only behind its own switch and on top of eligible external files.
        // The local Shell switch stays refused either way: it would open
        // background commands and monitors an external worker cannot serve.
        boolean externalShell = workspace && harness.isExternalWorkspaceShellEnabled();
        // Only the Shell lane's own extras are checked here. Calling
        // settings.isExternalWorkspaceFilesConfigured() would re-enter this
        // method through its own factory.validate() and recurse forever; the
        // rest of this method already is the external-files eligibility rule.
        if (harness.isWorkspaceFilesEnabled() && !workspace
                || harness.isWorkspaceShellEnabled()
                || externalShell && (!settings.getToolPublication().isEnabled()
                        || harness.getApprovalMode() == null
                        || !Set.of("default", "auto-edit")
                                .contains(harness.getApprovalMode().toLowerCase(java.util.Locale.ROOT)))
                || workspace && (settings.getManagedExtensions().isEnabled() || settings.getExtensions().isEnabled())
                || !runtimeBroker.getWorkspaceMounts().isEmpty()
                || !runtimeBroker.getResidentWorkspaces().isEmpty()
                || StringUtils.isNotBlank(runtimeBroker.getWorkspaceCreationRoot())
                || runtimeBroker.isLocalDirectoryImportEnabled()
                || runtimeBroker.isVerifiedWorkspaceRecoveryEnabled()
                || runtimeBroker.isOperatorRecoveryEnabled()
                || runtimeBroker.isChildWorkspacesEnabled() || runtimeBroker.isChildSnapshotsEnabled()
                || runtimeBroker.getSsh().isEnabled() || !runtimeBroker.getSsh().getNodes().isEmpty()) {
            throw new IllegalStateException(workspace
                    ? "External Workspace Runtime supports registered files Sessions, plus foreground Shell"
                            + " behind qwen.managed-agent.harness.external-workspace-shell-enabled with tool"
                            + " publication and default or auto-edit approval; local mounts, local Shell,"
                            + " extensions, children and recovery features must stay disabled"
                    : "External Runtime supports scratch Sessions only;"
                            + " managed Workspace features must be disabled");
        }
        if (!"session".equals(runtimeBroker.getIsolationClass())
                || externalShell && !"session".equals(runtimeBroker.getBoundSessionIsolationClass())
                || !("session".equals(runtimeBroker.getBoundSessionIsolationClass())
                        || workspace
                                && "workspace".equals(runtimeBroker.getBoundSessionIsolationClass()))
                || runtimeBroker.isSessionCreateWarm()) {
            throw new IllegalStateException("External Runtime requires session isolation without Session-create warm");
        }
        if (runtimeBroker.isTrustedLocalRebootRecovery()) {
            throw new IllegalStateException("External Runtime requires"
                    + " QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false");
        }
        URI provider;
        try {
            provider = URI.create(runtimeBroker.getExternalProviderUrl());
        } catch (IllegalArgumentException | NullPointerException error) {
            throw new IllegalStateException("External Runtime provider URL must be an HTTP(S) URL");
        }
        if ((!"http".equals(provider.getScheme()) && !"https".equals(provider.getScheme()))
                || provider.getHost() == null || provider.getUserInfo() != null
                || provider.getQuery() != null || provider.getFragment() != null) {
            throw new IllegalStateException("External Runtime provider URL must be an HTTP(S) URL"
                    + " without credentials, query or fragment");
        }
        String token = runtimeBroker.getExternalProviderToken();
        if (token == null || !token.matches("[A-Za-z0-9._~+/=-]{16,4096}")) {
            throw new IllegalStateException("External Runtime provider token must be 16-4096 safe characters");
        }
        // The shipped templates' placeholder satisfies the format rule, but
        // anyone can read it in the distribution (preflight refuses the same
        // shape for the Harness token).
        if (token.startsWith("replace-")) {
            throw new IllegalStateException("External Runtime provider token is still"
                    + " the shipped template placeholder");
        }
        String digest = harness.getCapabilityDigest();
        if (StringUtils.isNotBlank(digest) && !digest.matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalStateException("External Runtime Harness capability digest"
                    + " must be sha256:<64 lowercase hex>");
        }
        BrokerValues.requireId(runtimeBroker.getExternalProviderId(), "External Runtime provider ID");
        BrokerValues.requireId(runtimeBroker.getWorkspaceId(), "External Runtime workspace ID");
        String cwd = runtimeBroker.getWorkspaceCwd();
        if (cwd == null || !cwd.startsWith("/")
                || Arrays.stream(cwd.substring(1).split("/", -1))
                        .anyMatch(part -> part.isEmpty() || part.equals(".") || part.equals(".."))) {
            throw new IllegalStateException("External Runtime workspace cwd must be an absolute normalized"
                    + " worker path other than the filesystem root");
        }
        Duration request = runtimeBroker.getExternalRequestTimeout();
        Duration startup = runtimeBroker.getExternalStartupTimeout();
        if (request == null || request.compareTo(Duration.ofMillis(1)) < 0
                || startup == null || startup.compareTo(Duration.ofMillis(1)) < 0) {
            throw new IllegalStateException("External Runtime request and startup timeouts must be at least 1ms");
        }
    }
}
