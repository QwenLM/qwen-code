package com.alibaba.qwen.code.runtimebroker.provisioning.external;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.apache.commons.lang3.StringUtils;

import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Set;

public final class ExternalRuntimeProviderFactory implements RuntimeProviderFactory {
    @Override
    public Set<String> kinds() {
        return Set.of(RuntimeProviderKinds.EXTERNAL_SCRATCH, RuntimeProviderKinds.EXTERNAL_WORKSPACE,
                RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES, RuntimeProviderKinds.EXTERNAL_WORKSPACE_TOOLS);
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        validate(settings);
        var broker = settings.getRuntimeBroker();
        boolean workspace = ExternalRuntimeKinds.isWorkspace(broker.getProvisioner());
        ExternalStorageRegistry storage = workspace ? dependencies.externalStorage() : null;
        HttpRuntimeTransport filesTransport = null;
        if (ExternalRuntimeKinds.isFiles(broker.getProvisioner())) {
            if (!(transport instanceof HttpRuntimeTransport http)) {
                throw new IllegalStateException("External files Runtime requires the HTTP retirement transport");
            }
            filesTransport = http;
        }
        ExternalHttpRuntimeClient client = new ExternalHttpRuntimeClient(
                URI.create(broker.getExternalProviderUrl()), broker.getExternalProviderToken(),
                broker.getExternalRequestTimeout());
        return workspace
                ? new ExternalWorkspaceProvisioner(client, storage, broker.getExternalProviderId(),
                        broker.getExternalStartupTimeout(),
                        filesTransport,
                        ExternalRuntimeKinds.isTools(broker.getProvisioner()))
                : new ExternalRuntimeProvisioner(client, broker.getExternalProviderId(),
                        broker.getExternalStartupTimeout());
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        Check accepted = new Check("broker", Status.PASS,
                settings.getRuntimeBroker().getProvisioner() + " configuration accepted; provider reachability,"
                        + " worker attestation and storage registration are checked on first use", null);
        if (ExternalRuntimeKinds.isWorkspace(settings.getRuntimeBroker().getProvisioner())
                && !ExternalRuntimeKinds.isFiles(settings.getRuntimeBroker().getProvisioner())) {
            return List.of(accepted, new Check("external-prerequisite", Status.WARN,
                    "external-workspace can provision a storage-bound worker, but it"
                            + " cannot execute Hosted tools or close a Session yet; every placement fails closed",
                    "keep this profile out of production until files execution and Session close are verified (step 3b/3c)"));
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
        boolean externalFiles = ExternalRuntimeKinds.isFiles(provisioner);
        boolean externalTools = ExternalRuntimeKinds.isTools(provisioner);
        if (externalFiles && (!harness.isWorkspaceFilesEnabled() || !externalTools && harness.isWorkspaceShellEnabled()
                || settings.getManagedExtensions().isEnabled())) {
            throw new IllegalStateException("External files Runtime requires Workspace files without Shell or managed extensions");
        }
        if (externalTools && (!harness.isWorkspaceShellEnabled() || !settings.getToolPublication().isEnabled()
                || !settings.getArtifacts().isEnabled() || StringUtils.isBlank(settings.getToolPublication().getServiceBaseUrl())
                || !settings.getToolPublication().getServiceBaseUrl().startsWith("https://"))) {
            throw new IllegalStateException("External tools Runtime requires foreground Shell and an HTTPS tool publication service");
        }
        if ((!externalFiles && harness.isWorkspaceFilesEnabled()) || (!externalTools && harness.isWorkspaceShellEnabled())
                || !runtimeBroker.getWorkspaceMounts().isEmpty()
                || !runtimeBroker.getResidentWorkspaces().isEmpty()
                || StringUtils.isNotBlank(runtimeBroker.getWorkspaceCreationRoot())
                || runtimeBroker.isLocalDirectoryImportEnabled()
                || runtimeBroker.isVerifiedWorkspaceRecoveryEnabled()
                || runtimeBroker.isOperatorRecoveryEnabled()
                || runtimeBroker.isChildWorkspacesEnabled() || runtimeBroker.isChildSnapshotsEnabled()
                || runtimeBroker.getSsh().isEnabled() || !runtimeBroker.getSsh().getNodes().isEmpty()) {
            throw new IllegalStateException(ExternalRuntimeKinds.isWorkspace(provisioner)
                    ? "External Workspace Runtime is a storage provisioning prerequisite;"
                            + " managed Workspace files, Shell and recovery features must stay"
                            + " disabled until files execution and Session close are verified"
                    : "External Runtime supports scratch Sessions only;"
                            + " managed Workspace features must be disabled");
        }
        if (!"session".equals(runtimeBroker.getIsolationClass())
                || !"session".equals(runtimeBroker.getBoundSessionIsolationClass())
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
                || java.util.Arrays.stream(cwd.substring(1).split("/", -1))
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
