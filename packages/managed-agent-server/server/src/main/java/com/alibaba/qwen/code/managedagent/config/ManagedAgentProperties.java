package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import jakarta.annotation.PostConstruct;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.NestedConfigurationProperty;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.convert.DurationUnit;
import org.springframework.boot.web.server.Ssl;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

@ConfigurationProperties("qwen.managed-agent")
@Getter
@Setter
public class ManagedAgentProperties
        implements EnvironmentAware,
                com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings {
    private static final Logger LOG = LoggerFactory.getLogger(
            ManagedAgentProperties.class);

    // The keys the Harness reads from its environment file, which both of
    // its readers must take the same way. NONE: the configuration metadata
    // would otherwise list the constant as a setting, under the class's
    // @Getter.
    @Getter(AccessLevel.NONE)
    private static final Set<String> STRICT_HARNESS_KEYS = Set.of("QWEN_SERVER_TOKEN",
            "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", "QWEN_MANAGED_RUNTIME_BROKER_URL",
            "QWEN_MANAGED_RUNTIME_BROKER_TOKEN");
    // `-` stays last, where it is literal inside the character class.
    private static final String CREDENTIAL_PUNCTUATION = "._:/+=-";
    private static final Pattern PLAIN_CREDENTIAL =
            Pattern.compile("[A-Za-z0-9" + CREDENTIAL_PUNCTUATION + "]*");
    // A URL may also bracket an IPv6 literal; both readers take `[` and `]`
    // literally in a value.
    private static final String BROKER_URL_KEY = "QWEN_MANAGED_RUNTIME_BROKER_URL";
    private static final Pattern PLAIN_URL =
            Pattern.compile("[A-Za-z0-9\\[\\]" + CREDENTIAL_PUNCTUATION + "]*");

    private final Harness harness = new Harness();
    private final SessionStore sessionStore = new SessionStore();
    private final ToolPublication toolPublication = new ToolPublication();
    private final Artifacts artifacts = new Artifacts();
    private final Extensions extensions = new Extensions();
    private final ManagedExtensions managedExtensions = new ManagedExtensions();
    private final Dispatch dispatch = new Dispatch();
    private final Events events = new Events();
    private final RuntimeBroker runtimeBroker = new RuntimeBroker();
    private final Auth auth = new Auth();
    private final InternalServer internalServer = new InternalServer();
    private final Automation automation = new Automation();
    private final Channels channels = new Channels();
    private final EventTransport eventTransport = new EventTransport();
    private String agentRevision = "1";
    // The tool profiles a stored AgentDefinition may select (D8c-1).
    // hosted-workspace-files/2 joins only after the #13166 glob rollout.
    private List<String> definitionToolProfiles =
            List.of("hosted-workspace-files/1");
    private List<String> definitionModels = List.of();
    private List<ModelOption> modelCatalog = List.of();
    private String trustedActorHeader = "";
    // The account the server runs as; preflight checks file access as it.
    private String serviceUser = "";
    // Validation may run more than once; the file is read only the first time.
    @Getter(AccessLevel.NONE)
    @Setter(AccessLevel.NONE)
    private boolean harnessCredentialsApplied;
    @Getter(AccessLevel.NONE)
    @Setter(AccessLevel.NONE)
    private String harnessBrokerUrl = "";
    // Null on a plain `new`; the sweep then falls back to magnitude bands.
    @Getter(AccessLevel.NONE)
    private Environment environment;

    public boolean admitsPublicChildAgents() {
        return harness.isWorkspaceChildAgentsEnabled() && harness.isWorkspaceShellEnabled()
                && runtimeBroker.isDurableLocalProcess()
                && com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(runtimeBroker.getProvisioner())
                && "session".equals(runtimeBroker.getBoundSessionIsolationClass());
    }

    public void setModelCatalog(List<ModelOption> modelCatalog) {
        this.modelCatalog = List.copyOf(modelCatalog);
    }

    @Getter
    @Setter
    public static class ModelOption
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .ModelOption {
        private String modelId;
        private String label;
    }

    public void setServiceUser(String serviceUser) {
        this.serviceUser = serviceUser == null ? "" : serviceUser.strip();
    }

    @Override
    public void setEnvironment(Environment environment) {
        this.environment = environment;
    }

    /** Runs the startup validation without a Spring context. */
    public void validateForPreflight() {
        validateWorkspaceFiles();
    }

    // The Harness's own environment file is the one copy of the shared
    // credentials. Its values reach this configuration only, never this
    // process's environment, which Runtime workers would inherit.
    private void applyHarnessCredentialsFile() {
        String file = harness.getCredentialsFile();
        if (!harness.isEnabled() || harnessCredentialsApplied || StringUtils.isBlank(file)) {
            return;
        }
        if (StringUtils.isNotBlank(harness.getToken()) || StringUtils.isNotBlank(harness.getCapabilityDigest())) {
            throw new IllegalStateException("Configure the Hosted Harness token and capability digest either in"
                    + " harness.credentials-file or directly, not both");
        }
        Map<String, String> values = readHarnessEnvironmentFile(file);
        String token = credential(values, "QWEN_SERVER_TOKEN", file);
        String digest = credential(values, "QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST", file);
        // The Harness takes an empty value as set, and then refuses to start
        // without the other half of the pair.
        for (String key : List.of(BROKER_URL_KEY, "QWEN_MANAGED_RUNTIME_BROKER_TOKEN")) {
            if ("".equals(values.get(key))) {
                throw new IllegalStateException("Hosted Harness credentials file " + file + " sets " + key
                        + " to an empty value, which the Hosted Harness refuses; set it or remove the line");
            }
        }
        // Optional: a text-only deployment has no Broker to share a token with.
        String brokerToken = values.get("QWEN_MANAGED_RUNTIME_BROKER_TOKEN");
        boolean sharesBrokerToken = StringUtils.isNotBlank(brokerToken);
        // The Harness takes the URL and token together or not at all.
        if (sharesBrokerToken != StringUtils.isNotBlank(values.get(BROKER_URL_KEY))) {
            throw new IllegalStateException("Set QWEN_MANAGED_RUNTIME_BROKER_URL and"
                    + " QWEN_MANAGED_RUNTIME_BROKER_TOKEN together in harness.credentials-file, or neither");
        }
        if (sharesBrokerToken && StringUtils.isNotBlank(runtimeBroker.getToken())) {
            throw new IllegalStateException("Configure the Runtime Broker token either in"
                    + " harness.credentials-file or directly, not both");
        }
        harness.setToken(token);
        harness.setCapabilityDigest(digest);
        if (sharesBrokerToken) {
            runtimeBroker.setToken(brokerToken);
        }
        harnessBrokerUrl = values.getOrDefault(BROKER_URL_KEY, "");
        harnessCredentialsApplied = true;
    }

    /** Whether startup validation has bound the credentials from the Harness credentials file. */
    public boolean harnessCredentialsApplied() {
        return harnessCredentialsApplied;
    }

    /** The Broker URL the Harness credentials file gives the Harness, or empty; read with the credentials. */
    public String harnessBrokerUrl() {
        return harnessBrokerUrl;
    }

    // systemd and a shell `source` both read this file for the Harness, so
    // accept only lines both read the way this parser does and refuse the
    // rest, instead of silently taking a different value.
    private static Map<String, String> readHarnessEnvironmentFile(String file) {
        String[] lines;
        try {
            lines = Files.readString(Path.of(file), StandardCharsets.UTF_8).split("\n", -1);
        } catch (IOException | RuntimeException error) {
            throw new IllegalStateException("Hosted Harness credentials file " + file + " cannot be read ("
                    + error.getClass().getSimpleName() + ")");
        }
        Map<String, String> values = new LinkedHashMap<>();
        for (int index = 0; index < lines.length; index++) {
            // A shell keeps a carriage return in the value.
            if (lines[index].indexOf('\r') >= 0) {
                throw unsupportedCredentialLine(file, index, "a carriage return");
            }
            String line = lines[index].strip();
            if (line.endsWith("\\")) {
                throw unsupportedCredentialLine(file, index, "a line continuation");
            }
            // systemd skips a `;` comment, but a shell refuses it and stops
            // reading the file there, wherever it falls.
            if (line.startsWith(";")) {
                throw unsupportedCredentialLine(file, index, "a comment starting with `;` instead of `#`");
            }
            int separator = line.indexOf('=');
            if (line.startsWith("#") || separator < 0) {
                continue;
            }
            String key = line.substring(0, separator).strip();
            String value = line.substring(separator + 1);
            // systemd ignores `export KEY=value`, which a shell assigns, and a
            // shell runs `NAME KEY=value` as a command.
            if (key.chars().anyMatch(Character::isWhitespace)) {
                throw unsupportedCredentialLine(file, index, "a key that is not a bare variable name");
            }
            boolean strict = STRICT_HARNESS_KEYS.contains(key);
            // A shell runs `KEY = value` or `KEY= value` as a command instead.
            if (strict && (key.length() != separator || !value.equals(value.stripLeading()))) {
                throw unsupportedCredentialLine(file, index, "whitespace around `=` in " + key);
            }
            value = value.strip();
            char quote = value.isEmpty() ? 0 : value.charAt(0);
            if (quote == '"' && value.indexOf('\\') >= 0) {
                throw unsupportedCredentialLine(file, index, "an escape inside double quotes");
            }
            if (quote == '"' || quote == '\'') {
                int close = value.indexOf(quote, 1);
                if (close < 0) {
                    throw unsupportedCredentialLine(file, index, "an unterminated quote");
                }
                if (close != value.length() - 1) {
                    throw unsupportedCredentialLine(file, index, "text after a closing quote");
                }
                value = value.substring(1, close);
            }
            // Both readers take these characters literally anywhere in a
            // value; a shell gives others, such as `;`, `&` or `~`, meaning.
            boolean url = BROKER_URL_KEY.equals(key);
            if (strict && !(url ? PLAIN_URL : PLAIN_CREDENTIAL).matcher(value).matches()) {
                throw unsupportedCredentialLine(file, index, "a character other than letters, digits"
                        + (url ? ", `[`, `]`" : "") + " and `" + CREDENTIAL_PUNCTUATION + "` in " + key);
            }
            values.put(key, value);
        }
        return values;
    }

    // Names the line, never its content: the line may hold a credential.
    private static IllegalStateException unsupportedCredentialLine(String file, int index, String construct) {
        return new IllegalStateException("Hosted Harness credentials file " + file + " line " + (index + 1)
                + " uses " + construct + "; write KEY=value without continuations, escapes, expansions"
                + " or trailing text");
    }

    private static String credential(Map<String, String> values, String key, String file) {
        String value = values.get(key);
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Hosted Harness credentials file " + file + " does not set " + key);
        }
        return value;
    }

    // On a single host the Harness reaches the store routes on this
    // server's loopback listener, and the store scope is the Runtime
    // Broker's workspace identity, so neither needs its own setting.
    private void applySessionStoreDefaults() {
        if (!sessionStore.isEnabled()) {
            return;
        }
        if (StringUtils.isBlank(sessionStore.getBaseUrl()) && environment != null) {
            sessionStore.setBaseUrl(localStoreBaseUrl());
        }
        if (StringUtils.isNotBlank(sessionStore.getWorkspaceId())) {
            return;
        }
        String provisioner = runtimeBroker.getProvisioner();
        if (StringUtils.isNotBlank(runtimeBroker.getWorkspaceId())) {
            sessionStore.setWorkspaceId(runtimeBroker.getWorkspaceId());
        } else if (StringUtils.isNotBlank(runtimeBroker.getWorkspaceCwd())
                && (com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(provisioner)
                        || "kubernetes".equals(provisioner))) {
            sessionStore.setWorkspaceId(EmbeddedRuntimeBroker.workspaceId(runtimeBroker));
        }
    }

    private String localStoreBaseUrl() {
        boolean internal = internalServer.getPort() > 0;
        int port = internal ? internalServer.getPort()
                : environment.getProperty("server.port", Integer.class, 8080);
        String address = internal ? internalServer.getAddress()
                : environment.getProperty("server.address", "");
        // The internal listener is always plaintext; a TLS public listener
        // needs a URL whose certificate the Harness accepts.
        if (port <= 0 || !internal
                && Ssl.isEnabled(Binder.get(environment).bind("server.ssl", Ssl.class).orElse(null))) {
            return "";
        }
        return switch (address) {
            case "", "0.0.0.0", "::", "127.0.0.1" -> "http://127.0.0.1:" + port;
            case "::1" -> "http://[::1]:" + port;
            default -> "";
        };
    }

    @PostConstruct
    void validateWorkspaceFiles() {
        applySessionStoreDefaults();
        applyHarnessCredentialsFile();
        // The sweep runs first, so a bare milliseconds-style override
        // warns with the unit hint before the range check below fails the
        // boot, and the refusal message itself names the convention.
        warnOnSecondScaleOverrides();
        validateExternalRuntime();
        if (runtimeBroker.getSsh().isEnabled() && (!harness.isWorkspaceFilesEnabled()
                || runtimeBroker.getSsh().getNodes().isEmpty())) {
            throw new IllegalStateException("SSH Runtime requires Workspace files and configured nodes");
        }
        runtimeBroker.getRetention().validate();
        long timeout = harness.getApprovalTimeout().toMillis();
        if (timeout < 1000 || timeout > 86400000) {
            throw new IllegalStateException("Hosted approval timeout must be between 1s and 24h;"
                    + " a suffix-less number binds as seconds, so write 300s rather than 300000");
        }
        String mode = harness.getApprovalMode();
        boolean residentFiles = "kubernetes-workspace".equals(runtimeBroker.getProvisioner())
                && "workspace".equals(runtimeBroker.getIsolationClass())
                && !runtimeBroker.getResidentWorkspaces().isEmpty() && runtimeBroker.getWorkspaceMounts().isEmpty()
                && runtimeBroker.getSsh().getNodes().isEmpty()
                && !runtimeBroker.isTrustedLocalRebootRecovery() && !runtimeBroker.isVerifiedWorkspaceRecoveryEnabled()
                && !runtimeBroker.isChildWorkspacesEnabled() && !harness.isWorkspaceShellEnabled()
                && !runtimeBroker.getResidentKubernetesApiUrl().isBlank()
                && !runtimeBroker.getResidentKubernetesTokenFile().isBlank() && !runtimeBroker.getResidentKubernetesCaFile().isBlank();
        if (!runtimeBroker.getResidentWorkspaces().isEmpty()) {
            new com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaces(runtimeBroker.getResidentWorkspaces());
            if (!residentFiles || !harness.isWorkspaceFilesEnabled()) {
                throw new IllegalStateException("Resident Workspaces require exclusive CSI/files configuration");
            }
        }
        if (harness.isWorkspaceShellEnabled()
                && (!harness.isWorkspaceFilesEnabled()
                        || mode == null
                        || !Set.of("default", "auto-edit").contains(mode.toLowerCase(Locale.ROOT)))) {
            throw new IllegalStateException("Hosted Workspace Shell requires Workspace files"
                    + " and default or auto-edit approval mode");
        }
        if (harness.isWorkspaceFilesEnabled()
                && (!harness.isEnabled()
                        || !sessionStore.isEnabled()
                        || !runtimeBroker.isEnabled()
                        || !residentFiles && !isExternalWorkspaceFilesConfigured()
                         && (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(runtimeBroker.getProvisioner())
                        || !WorkspaceExecutionProfile.admitsIsolationClass(runtimeBroker.getIsolationClass())
                        || (runtimeBroker.getWorkspaceMounts().isEmpty()
                                && runtimeBroker.getWorkspaceCreationRoot().isBlank()
                                && !runtimeBroker.isVerifiedWorkspaceRecoveryEnabled()
                                && runtimeBroker.getSsh().getNodes().isEmpty()))
                        || mode == null
                        || !Set.of("yolo", "default", "auto-edit")
                                .contains(
                                        mode.toLowerCase(Locale.ROOT)))) {
            throw new IllegalStateException(
                    "Hosted Workspace files require"
                            + " a supported Harness, Session Store and Session-isolated"
                            + " local-process Broker with Workspace mounts");
        }
        String boundSessionIsolation = runtimeBroker.getBoundSessionIsolationClass();
        if (!"session".equals(boundSessionIsolation) && !"workspace".equals(boundSessionIsolation)) {
            throw new IllegalStateException("Bound-Session isolation must be session or workspace");
        }
        if ("workspace".equals(boundSessionIsolation)
                && !ExternalRuntimeKinds.isWorkspace(runtimeBroker.getProvisioner())
                && (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(runtimeBroker.getProvisioner())
                        || !runtimeBroker.isDurableLocalProcess()
                        || runtimeBroker.isChildWorkspacesEnabled())) {
            throw new IllegalStateException("Workspace-isolated bound Sessions require a"
                    + " durable local-process or external-workspace Broker and cannot"
                    + " combine with child Workspaces");
        }
        // Under Session isolation, which SSH-bound Sessions always use, a
        // create warm would start one worker per unused Session and
        // disqualify its never-initialized close receipt.
        if (runtimeBroker.isSessionCreateWarm() && (!"workspace".equals(boundSessionIsolation)
                || !runtimeBroker.getSsh().getNodes().isEmpty())) {
            throw new IllegalStateException("Session-create warm requires Workspace-isolated"
                    + " bound Sessions and no SSH nodes");
        }
        if ((!runtimeBroker.getWorkspaceCreationRoot().isBlank() || runtimeBroker.isLocalDirectoryImportEnabled())
                && (!harness.isWorkspaceFilesEnabled()
                        || !runtimeBroker.isDurableLocalProcess()
                        || !runtimeBroker.isVerifiedWorkspaceRecoveryEnabled())) {
            throw new IllegalStateException("Workspace creation requires Workspace files, durable"
                    + " local-process execution and verified Workspace recovery");
        }
        // A definition Session publishes its instructions through the
        // Session Store at Harness create, so the Harness implies the
        // Store even when Workspace files are off (D8c-2).
        if (harness.isEnabled() && !sessionStore.isEnabled()) {
            throw new IllegalStateException(
                    "Hosted Harness requires the Managed Session Store");
        }
        if (automation.isEnabled()) {
            // A non-positive value fails at tick time, nearly silently:
            // 0 slots per tick stops every scheduled fire behind one
            // warn line, and 0 concurrency refuses every allow slot.
            if (automation.getMaxSlotsPerTick() < 1) {
                throw new IllegalStateException(
                        "Automation max-slots-per-tick must be a positive count.");
            }
            if (automation.getConcurrency() < 1) {
                throw new IllegalStateException(
                        "Automation concurrency must be a positive count.");
            }
            if (automation.getScannerThreads() < 1) {
                throw new IllegalStateException(
                        "Automation scanner-threads must be a positive count.");
            }
            if (!(automation.getScanDelay().toMillis() > 0)
                    || !(automation.getLease().toMillis() > 0)
                    || !(automation.getLateTolerance().toMillis() > 0)
                    || !(automation.getLookback().toMillis() > 0)) {
                throw new IllegalStateException(
                        "Automation scan-delay, lease, late-tolerance and lookback must be positive durations.");
            }
        }
        // Snapshot children (#13753 I3) are read-only child Workspaces: they
        // need the capability itself. Their switch is separate so it can be
        // turned on once every replica runs a relay that knows the mode.
        if (runtimeBroker.isChildSnapshotsEnabled() && !runtimeBroker.isChildWorkspacesEnabled()) {
            throw new IllegalStateException("Child snapshots require child Workspaces");
        }
        // The child Workspace capability (#13753 I1) runs Git in this
        // control plane against an administrator mount, so it needs the
        // local-process Broker that mounts the storage here.
        if (runtimeBroker.isChildWorkspacesEnabled()) {
            // A merge runs once the child Session is closed (#13753 I2), and
            // only a durable local-process Broker can close one.
            if (!runtimeBroker.isEnabled()
                    || !com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS.equals(runtimeBroker.getProvisioner())
                    || !"session".equals(runtimeBroker.getIsolationClass())
                    || !runtimeBroker.isDurableLocalProcess()
                    || (runtimeBroker.getWorkspaceMounts().isEmpty()
                                && runtimeBroker.getWorkspaceCreationRoot().isBlank())) {
                throw new IllegalStateException("Child Workspaces require a Session-isolated"
                        + " durable local-process Broker with Workspace mounts");
            }
            // A suffix-less number binds as milliseconds: refuse it here,
            // naming the key, rather than time out every Git command.
            Duration gitTimeout = runtimeBroker.getChildWorkspaceGitTimeout();
            if (gitTimeout == null || gitTimeout.compareTo(Duration.ofSeconds(1)) < 0
                    || gitTimeout.compareTo(Duration.ofHours(1)) > 0) {
                throw new IllegalStateException("child-workspace-git-timeout must be between 1s and 1h");
            }
            if (!childWorkspacesSupportedOn(System.getProperty("os.name", ""))) {
                throw new IllegalStateException("Child Workspaces are not supported on Windows");
            }
            // The steps name the files Git reports: a JVM whose file names
            // are not UTF-8 (a C or POSIX locale) cannot spell most of them.
            if (!utf8FileNames(System.getProperty("sun.jnu.encoding", ""))) {
                throw new IllegalStateException("Child Workspaces need UTF-8 file names; run the server"
                        + " under a UTF-8 locale (sun.jnu.encoding is "
                        + System.getProperty("sun.jnu.encoding") + ")");
            }
        }
    }

    /** Static configuration eligibility, never negotiated readiness or worker proof. */
    public boolean isExternalWorkspaceFilesConfigured() {
        if (!ExternalRuntimeKinds.isWorkspace(runtimeBroker.getProvisioner())
                || !harness.isWorkspaceFilesEnabled() || !harness.isEnabled()
                || !sessionStore.isEnabled() || !runtimeBroker.isEnabled()) {
            return false;
        }
        try {
            validateExternalRuntime();
            return harness.getApprovalMode() != null
                    && Set.of("yolo", "default", "auto-edit").contains(harness.getApprovalMode().toLowerCase(Locale.ROOT));
        } catch (IllegalStateException | IllegalArgumentException invalid) {
            return false;
        }
    }

    /** Shared startup and preflight validation for every external worker kind. */
    public void validateExternalRuntime() {
        String provisioner = runtimeBroker.getProvisioner();
        if (!ExternalRuntimeKinds.isExternal(provisioner)) {
            return;
        }
        if (harness.isWorkspaceFilesEnabled() && !ExternalRuntimeKinds.isWorkspace(provisioner)
                || harness.isWorkspaceShellEnabled()
                || ExternalRuntimeKinds.isWorkspace(provisioner) && (managedExtensions.isEnabled() || extensions.isEnabled())
                || !runtimeBroker.getWorkspaceMounts().isEmpty()
                || !runtimeBroker.getResidentWorkspaces().isEmpty()
                || StringUtils.isNotBlank(runtimeBroker.getWorkspaceCreationRoot())
                || runtimeBroker.isLocalDirectoryImportEnabled()
                || runtimeBroker.isVerifiedWorkspaceRecoveryEnabled()
                || runtimeBroker.isOperatorRecoveryEnabled()
                || runtimeBroker.isChildWorkspacesEnabled() || runtimeBroker.isChildSnapshotsEnabled()
                || runtimeBroker.getSsh().isEnabled() || !runtimeBroker.getSsh().getNodes().isEmpty()) {
            throw new IllegalStateException(ExternalRuntimeKinds.isWorkspace(provisioner)
                    ? "External Workspace Runtime supports registered files-only Sessions;"
                            + " local mounts, Shell, extensions, children and recovery features must stay disabled"
                    : "External Runtime supports scratch Sessions only;"
                            + " managed Workspace features must be disabled");
        }
        if (!"session".equals(runtimeBroker.getIsolationClass())
                || !("session".equals(runtimeBroker.getBoundSessionIsolationClass())
                        || ExternalRuntimeKinds.isWorkspace(provisioner)
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

    static boolean utf8FileNames(String encoding) {
        return "UTF-8".equalsIgnoreCase(encoding) || "UTF8".equalsIgnoreCase(encoding);
    }

    /** Child Workspaces run their Git steps on POSIX hosts only. */
    static boolean childWorkspacesSupportedOn(String osName) {
        return !osName.toLowerCase(Locale.ROOT).startsWith("windows");
    }

    // A suffix-less override bound milliseconds before the @DurationUnit
    // sweep and now binds seconds, and the written shape is the signal:
    // with an Environment (every Spring boot) the sweep reads each
    // seconds-convention field's raw property text, warns when it is a
    // bare integer and stays quiet on a suffixed value. With no
    // Environment (a plain `new`) the magnitude bands are the fallback:
    // a bound value at 1000x its field default or more is that flip's
    // signature, the mirror band catches the other direction — a bare
    // value meant in a larger unit binds at least 10x below the default
    // (zero is unambiguous and never trips) — and a required field ships
    // no default to compare against, so it warns from one hour up
    // instead. Warn, never refuse: a deliberate value must still boot.
    private void warnOnSecondScaleOverrides() {
        warnOnSecondScaleOverrides("qwen.managed-agent.", this,
                new ManagedAgentProperties(), environment);
    }

    private static void warnOnSecondScaleOverrides(String prefix,
            Object bound, Object initial, Environment environment) {
        for (Field field : bound.getClass().getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers())) {
                continue;
            }
            // Only Duration fields can carry the flipped unit, and only
            // the nested groups can hold one; both expose getXxx getters
            // (the boolean isXxx getters belong to fields skipped here).
            boolean duration = field.getType() == Duration.class;
            boolean group = field.getType().getEnclosingClass()
                    == ManagedAgentProperties.class;
            if (!duration && !group) {
                continue;
            }
            Object value;
            Object basis;
            try {
                Method getter = bound.getClass().getMethod("get"
                        + Character.toUpperCase(field.getName().charAt(0))
                        + field.getName().substring(1));
                value = getter.invoke(bound);
                basis = getter.invoke(initial);
            } catch (NoSuchMethodException | IllegalAccessException
                    | InvocationTargetException error) {
                throw new IllegalStateException(error);
            }
            String property = prefix + field.getName()
                    .replaceAll("([A-Z])", "-$1")
                    .toLowerCase(Locale.ROOT);
            if (duration) {
                DurationUnit unit = field.getAnnotation(DurationUnit.class);
                Duration basisDefault = basis instanceof Duration basisDuration
                        ? basisDuration : null;
                if (unit != null && unit.value() == ChronoUnit.SECONDS
                        && value instanceof Duration boundValue) {
                    String written = environment == null ? null
                            : environment.getProperty(property);
                    if (written != null) {
                        // A bare integer is the stale milliseconds-style
                        // override; a suffixed value never flips units.
                        String text = written.trim();
                        if (text.matches("-?\\d+")) {
                            LOG.warn("{}={} binds as {} (seconds); before"
                                    + " the @DurationUnit sweep the same"
                                    + " suffix-less value bound as"
                                    + " milliseconds ({}). Write an"
                                    + " explicit suffix (for example"
                                    + " 1800000ms or 30m) to confirm"
                                    + " the intent.",
                                    property, text, boundValue,
                                    Duration.ofMillis(Long.parseLong(text)));
                        }
                    } else if (environment == null && basisDefault != null
                            && boundValue.compareTo(
                                    basisDefault.multipliedBy(1000)) >= 0) {
                        LOG.warn("{} resolved to {}, at least 1000x its"
                                + " default ({}) — the signature of a stale"
                                + " milliseconds-style override: a"
                                + " suffix-less number now binds as"
                                + " seconds. Write an explicit suffix"
                                + " (for example 1800000ms) to confirm"
                                + " the intent.",
                                property, boundValue, basisDefault);
                    } else if (environment == null && basisDefault != null
                            && !boundValue.isZero()
                            && !boundValue.isNegative()
                            && boundValue.compareTo(
                                    basisDefault.dividedBy(10)) <= 0) {
                        LOG.warn("{} resolved to {}, at least 10x below its"
                                + " default ({}) — a suffix-less number"
                                + " now binds as seconds, so a value meant"
                                + " in a larger unit shrinks this far."
                                + " Write an explicit suffix (for example"
                                + " 30m) to confirm the intent.",
                                property, boundValue, basisDefault);
                    } else if (environment == null && basisDefault == null
                            && boundValue.compareTo(Duration.ofHours(1))
                                    >= 0) {
                        LOG.warn("{} resolved to {} — this required setting"
                                + " ships no default to compare against: a"
                                + " suffix-less number now binds as"
                                + " seconds, and this scale is the"
                                + " signature of a stale milliseconds-style"
                                + " override. Write an explicit suffix"
                                + " (for example 1800000ms) to confirm"
                                + " the intent.",
                                property, boundValue);
                    }
                }
            } else if (value != null) {
                warnOnSecondScaleOverrides(property + ".", value, basis,
                        environment);
            }
        }
    }

    @Getter
    @Setter
    public static class Harness
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Harness {
        private final HarnessPool pool = new HarnessPool();

        private boolean enabled;
        private boolean workspaceFilesEnabled;
        private boolean workspaceShellEnabled;
        private boolean workspaceChildAgentsEnabled = true;
        private String baseUrl = "http://127.0.0.1:4170";
        private String token = "";
        private String capabilityDigest = "";
        private String credentialsFile = "";
        private String approvalMode = "yolo";
        // Unit-less operator overrides must bind in the annotated unit; an
        // un-annotated Duration silently binds milliseconds.
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration approvalTimeout = Duration.ofMinutes(10);

        @DurationUnit(ChronoUnit.SECONDS)
        private Duration connectTimeout = Duration.ofSeconds(5);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration requestTimeout = Duration.ofSeconds(30);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration loadTimeout = Duration.ofSeconds(120);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration heartbeatInterval = Duration.ofSeconds(30);
        /**
         * Turn-level deadline passed to the Harness at prompt admission. An
         * admitted Turn outliving it is settled by the Harness as a
         * classified deadline failure, so a stalled model stream cannot pin
         * a Session forever.
         */
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration turnDeadline = Duration.ofMinutes(30);
    }

    @Getter
    @Setter
    public static class HarnessPool
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .HarnessPool {
        private boolean enabled;
        private String discovery = "static";
        private List<HarnessInstance> instances = new ArrayList<>();
        private String keyStoreFile = "";
        private String keyStorePasswordFile = "";
        private String trustStoreFile = "";
        private String trustStorePasswordFile = "";
        private String kubernetesApiUrl = "https://kubernetes.default.svc";
        private String kubernetesTokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token";
        private String kubernetesCaFile = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
        private String namespace = "";
        private String serviceName = "";
        private String serviceUid = "";
        private String portName = "https";
    }

    @Getter
    @Setter
    public static class HarnessInstance
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .HarnessInstance {
        private String instanceId = "";
        private String baseUrl = "";
    }

    @Getter
    @Setter
    public static class SessionStore
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .SessionStore {
        private boolean enabled;
        private String baseUrl = "";
        private String workspaceId = "";
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration writerLeaseDuration = Duration.ofSeconds(60);
        private String bindingKey = "";
        private boolean allowInsecureHttp;
    }

    @Getter
    @Setter
    public static class Auth {
        private String mode = "auto";
        private String signingKey = "";
        // MILLIS, deliberately against the sweep's SECONDS: a stale
        // milliseconds-style override (300000) must keep binding the
        // documented 5m — under SECONDS it would silently widen the
        // signature-replay window to ~83h and still pass BrokerSecurity's
        // 1s floor.
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration allowedDrift = Duration.ofMinutes(5);
        private boolean allowInsecureBind;
        private long maxSignedBodyBytes = 10 * 1024 * 1024;
    }

    @Getter
    @Setter
    public static class InternalServer {
        private int port;
        private String address = "127.0.0.1";

        // A blank value comes from an unset template variable; both the
        // startup guard and the connector must read it as the default.
        public String getAddress() {
            return StringUtils.isBlank(address) ? "127.0.0.1"
                    : address;
        }
    }

    @Getter
    @Setter
    public static class ToolPublication
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .ToolPublication {
        private boolean enabled;
        private String ossEndpoint = "";
        private String ossRegion = "";
        private String ossBucket = "";
        private String serviceBaseUrl = "";
        private Long executionBytes;
        private Long sessionBytes;
        private Long tenantBytes;
        private Long activeCaptures;
        private Integer entryConcurrency;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration operationTimeout;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration claimTimeout;
        private Long verificationBytesPerSecond;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration maxVerificationTimeout;
        private boolean gcEnabled;
        private boolean asyncVerificationEnabled;
        private int verificationConcurrency = 2;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration deletionGrace = Duration.ofHours(24);
    }

    @Getter
    @Setter
    public static class ManagedExtensions
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .ManagedExtensions {
        private boolean enabled;
        private String mode = "linux-cgroup";
        private String cacheDirectory = "";
        private String cgroupRoot = "";
    }

    @Getter
    @Setter
    public static class Extensions
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Extensions {
        private boolean enabled;
        private String artifactDirectory = "";
        private List<String> allowedActors = List.of();

        public void setAllowedActors(List<String> value) { allowedActors = List.copyOf(value); }
    }

    @Getter
    @Setter
    public static class Artifacts
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Artifacts {
        private boolean enabled;
        private boolean publishOriginal;
        private boolean publishPreview;
        private int maxConcurrentReads = 4;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readTimeout = Duration.ofMinutes(2);
        /** How often a download re-verifies content access; PT0S checks on every chunk. */
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readRevalidationInterval = Duration.ofSeconds(5);
    }

    @Getter
    @Setter
    public static class Dispatch
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Dispatch {
        // No typed scan-delay field. The deployed default comes from
        // application.yml (`dispatch.scan-delay: '1s'`); the same
        // "${...scan-delay:1s}" fallback is repeated by four @Scheduled
        // methods — ActionResponseCoordinator.recover,
        // HarnessCoordinator.recoverExpiredTurns,
        // SessionLifecycleCoordinator.recoverOperations and
        // HostedCleanupRetryCoordinator.retryOwedCleanup — and @Scheduled
        // reads a bare number as milliseconds, not seconds.
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration leaseDuration = Duration.ofSeconds(60);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration leaseRenewInterval = Duration.ofSeconds(20);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration retryInitialDelay = Duration.ofSeconds(1);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration retryMaxDelay = Duration.ofMinutes(1);
        private int maxPreAdmissionRetries = 5;
        private int maxPostAdmissionRetries = 10;
        private int maxOperationRetries = 10;
    }

    @Getter
    @Setter
    public static class Events
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Events {
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration pollInterval = Duration.ofSeconds(5);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration heartbeatInterval = Duration.ofSeconds(15);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration streamTimeout = Duration.ofMinutes(30);
        /**
         * How often a stream re-verifies the subscriber's read grant; PT0S
         * checks before every event.
         */
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readGrantRecheckInterval = Duration.ofSeconds(5);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration batchInterval = Duration.ofMillis(75);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration materializeInterval = Duration.ofMillis(100);
        private int batchMaxEvents = 64;
        private int batchMaxBytes = 65536;
        /**
         * Whether the scheduled pass raises each Session's replay floor as
         * far as its Snapshot proves safe. Disabled by default; events are
         * never deleted here either way.
         */
        private boolean replayFloorEnabled;
    }

    @Getter
    @Setter
    public static class RuntimeBroker
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .RuntimeBroker {
        // A class of its own, which the configuration metadata, and so the
        // configuration reference, leaves out unless marked nested.
        @NestedConfigurationProperty
        private final SshRuntimeSettings ssh = new SshRuntimeSettings();

        private boolean enabled;
        private final Retention retention = new Retention();
        private String host = "127.0.0.1";
        private int port = 4182;
        private boolean allowNonLoopback;
        private String token = "";
        private String provisioner = com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration v3ResultWindow = Duration.ofMinutes(30);
        private String workspaceId = "";
        private String workspaceGeneration = "1";
        private String workspaceCwd = "";
        private List<WorkspaceMount> workspaceMounts = List.of();
        private List<ResidentWorkspace> residentWorkspaces = List.of();
        private String residentKubernetesApiUrl = "";
        private String residentKubernetesTokenFile = "";
        private String residentKubernetesCaFile = "";
        private String workspaceCreationRoot = "";
        private boolean localDirectoryImportEnabled;
        private String isolationClass = "session";
        private String boundSessionIsolationClass = "session";
        private boolean sessionCreateWarm;
        private String stateDirectory = "";
        private boolean durableLocalProcess = true;
        private boolean trustedLocalRebootRecovery = true;
        private boolean operatorRecoveryEnabled;
        private boolean verifiedWorkspaceRecoveryEnabled;
        private String credentialKeyId = "";
        private String credentialKey = "";
        private Map<String, String> previousCredentialKeys =
                new LinkedHashMap<>();
        private String nodeExecutable = "";
        private String workerEntry = "";
        private String staticEndpoint = "";
        private String staticToken = "";
        private String externalProviderUrl = "";
        private String externalProviderToken = "";
        private String externalProviderId = "external";
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration externalRequestTimeout = Duration.ofSeconds(30);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration externalStartupTimeout = Duration.ofMinutes(2);
        private String staticRuntimeInstanceId = "standalone-runtime";
        private String staticLeaseId = "standalone-lease";
        private long staticEpoch = 1;
        private Map<String, String> environment = new LinkedHashMap<>();
        private boolean childWorkspacesEnabled;
        private boolean sessionWorktreesEnabled;
        /**
         * Whether hosted Sessions may launch read-only snapshot children
         * (#13753 I3). A relay from before snapshots would create one as a
         * shared writer, so this is turned on only after every control-plane
         * replica runs this version.
         */
        private boolean childSnapshotsEnabled;
        private String childWorkspaceGit = "git";
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration childWorkspaceGitTimeout = Duration.ofMinutes(2);

        @Getter
        @Setter
        public static class Retention
                implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                        .RuntimeBroker.Retention {
            private boolean enabled;
            @DurationUnit(ChronoUnit.DAYS)
            private Duration maxAge = Duration.ofDays(30);
            private int batchSize = 100;
            @DurationUnit(ChronoUnit.MILLIS)
            private Duration scanDelay = Duration.ofMinutes(1);

            void validate() {
                if (maxAge == null || maxAge.isZero() || maxAge.isNegative()
                        || maxAge.compareTo(Duration.ofMillis(1)) < 0
                        || scanDelay == null || scanDelay.isZero() || scanDelay.isNegative()
                        || scanDelay.toMillis() < 1 || batchSize < 1 || batchSize > 1000) {
                    throw new IllegalStateException("Runtime Broker retention requires positive max-age and scan-delay"
                            + " (at least 1ms), and batch-size between 1 and 1000");
                }
            }
        }

        public record WorkspaceMount(String tenantId, String storageId, String root)
                implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                        .RuntimeBroker.WorkspaceMount {}

        public record ResidentWorkspace(
                String workspaceId,
                long workspaceGeneration,
                com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration
                        registration,
                com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity protection,
                String image,
                List<String> command,
                List<com.alibaba.qwen.code.managedagent.contracts.runtime.WorkerArtifact> artifacts)
                implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                        .RuntimeBroker.ResidentWorkspace {
            public ResidentWorkspace {
                if (registration == null || protection == null || workspaceId == null || workspaceId.isBlank()
                        || workspaceGeneration < 1 || image == null || !image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                        || command == null || command.isEmpty() || command.size() > 32
                        || command.stream().anyMatch(value -> value == null || value.isBlank()
                                || value.length() > 8192 || value.indexOf('\0') >= 0)
                        || artifacts == null || artifacts.size() > 48
                        || artifacts.stream().anyMatch(java.util.Objects::isNull)
                        || artifacts.stream().map(com.alibaba.qwen.code.managedagent.contracts.runtime.WorkerArtifact::configMapName)
                                .distinct().count() != artifacts.size()) {
                    throw new IllegalArgumentException("Invalid resident Workspace configuration");
                }
                new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(registration.tenantId(),
                        workspaceId, workspaceGeneration, registration.storageId(), ".",
                        com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
                command = List.copyOf(command);
                artifacts = List.copyOf(artifacts);
            }
        }

        public void setResidentWorkspaces(List<ResidentWorkspace> value) { residentWorkspaces = List.copyOf(value); }
    }

    /** H6b/H6c: the automation scanner, its lease and the slot window. */
    @Getter
    @Setter
    public static class Automation
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Automation {
        private boolean enabled;
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration scanDelay = Duration.ofSeconds(10);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration lease = Duration.ofSeconds(60);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration lateTolerance = Duration.ofMinutes(5);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration lookback = Duration.ofHours(24);
        private int maxSlotsPerTick = 1000;
        private int concurrency = 4;
        private int scannerThreads = 4;
    }

    /** H5b/H5c: the trusted channel adapter surface and its claim lease. */
    @Getter
    @Setter
    public static class Channels
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.Channels {
        // No typed scan-delay field. The deployed default comes from
        // application.yml (`channels.scan-delay: '30s'`); the same
        // "${...channels.scan-delay:30s}" fallback drives
        // ManagedChannelService.reconcile, and @Scheduled reads a bare
        // number as milliseconds, not seconds.
        private boolean enabled;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration claimLease = Duration.ofMinutes(10);
    }

    /**
     * Broker-backed EventTransport (design 2026-10-04-managed-agent-event-transport): the
     * authoritative journal wire (phase MQ2b), and the public-event wire and the wake and
     * materialization consumers (phase MQ2c). Default off, so a flag-off deployment creates no
     * transport, producer or consumer bean and stays byte-identical. The topic must be a LITE
     * topic, and the capability-probe, wake-bootstrap and owner groups must be pre-created as LITE
     * groups bound to it — see EventTransportConfiguration for the deployment prerequisites.
     */
    @Getter
    @Setter
    public static class EventTransport
            implements com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings
                    .EventTransport {
        private boolean enabled;
        // The RocketMQ proxy gRPC endpoint (e.g. "host:8081").
        private String endpoints = "";
        // The parent topic the per-Session LiteTopics (journal and public
        // envelopes alike) and the wake bootstrap LiteTopic live under.
        private String topic = "";
        // The group the startup capability probe subscribes in; pre-created
        // as a LITE group bound to the topic like the lane groups.
        private String capabilityProbeGroup =
                "qwen-managed-journal-capability-probe";
        // The one LiteTopic every wake.requested envelope is also sent to, so
        // a node can learn of a wake nobody owns yet. Session ids are UUIDs,
        // so this name cannot collide with a Session's LiteTopic.
        private String wakeBootstrapLiteTopic = "qwen-wake-bootstrap";
        // Shared by every node; one dispatch reaches one member.
        private String wakeBootstrapGroup = "qwen-managed-wake-bootstrap";
        // Shared by every node; each subscribes it to the Sessions it holds.
        private String ownerGroup = "qwen-managed-session-owner";
        // How often the owner subscriptions follow this node's held Sessions.
        // Unit-less operator overrides must bind in the annotated unit.
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration ownerReconcileInterval = Duration.ofSeconds(1);
    }
}
