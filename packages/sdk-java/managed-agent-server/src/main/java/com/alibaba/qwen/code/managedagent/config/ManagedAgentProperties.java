package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import jakarta.annotation.PostConstruct;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.convert.DurationUnit;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@ConfigurationProperties("qwen.managed-agent")
public class ManagedAgentProperties implements EnvironmentAware {
    private static final Logger LOG = LoggerFactory.getLogger(
            ManagedAgentProperties.class);

    private final Harness harness = new Harness();
    private final SessionStore sessionStore = new SessionStore();
    private final ToolPublication toolPublication = new ToolPublication();
    private final Artifacts artifacts = new Artifacts();
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
    // Null on a plain `new`; the sweep then falls back to magnitude bands.
    private Environment environment;

    public Harness getHarness() {
        return harness;
    }

    public Auth getAuth() {
        return auth;
    }

    public InternalServer getInternalServer() {
        return internalServer;
    }

    public Automation getAutomation() {
        return automation;
    }

    public Channels getChannels() {
        return channels;
    }

    public EventTransport getEventTransport() {
        return eventTransport;
    }

    public SessionStore getSessionStore() {
        return sessionStore;
    }

    public ToolPublication getToolPublication() {
        return toolPublication;
    }

    public Artifacts getArtifacts() {
        return artifacts;
    }

    public Dispatch getDispatch() {
        return dispatch;
    }

    public Events getEvents() {
        return events;
    }

    public RuntimeBroker getRuntimeBroker() {
        return runtimeBroker;
    }

    public String getAgentRevision() {
        return agentRevision;
    }

    public void setAgentRevision(String agentRevision) {
        this.agentRevision = agentRevision;
    }
    public List<String> getDefinitionToolProfiles() {
        return definitionToolProfiles;
    }
    public void setDefinitionToolProfiles(
            List<String> definitionToolProfiles) {
        this.definitionToolProfiles = definitionToolProfiles;
    }

    public List<String> getDefinitionModels() {
        return definitionModels;
    }

    public void setDefinitionModels(List<String> definitionModels) {
        this.definitionModels = definitionModels;
    }

    public List<ModelOption> getModelCatalog() {
        return modelCatalog;
    }

    public void setModelCatalog(List<ModelOption> modelCatalog) {
        this.modelCatalog = List.copyOf(modelCatalog);
    }

    public static class ModelOption {
        private String modelId;
        private String label;

        public String getModelId() { return modelId; }
        public void setModelId(String modelId) { this.modelId = modelId; }
        public String getLabel() { return label; }
        public void setLabel(String label) { this.label = label; }
    }

    public String getTrustedActorHeader() {
        return trustedActorHeader;
    }

    public void setTrustedActorHeader(String trustedActorHeader) {
        this.trustedActorHeader = trustedActorHeader;
    }

    @Override
    public void setEnvironment(Environment environment) {
        this.environment = environment;
    }

    @PostConstruct
    void validateWorkspaceFiles() {
        // The sweep runs first, so a bare milliseconds-style override
        // warns with the unit hint before the range check below fails the
        // boot, and the refusal message itself names the convention.
        warnOnSecondScaleOverrides();
        runtimeBroker.getRetention().validate();
        long timeout = harness.getApprovalTimeout().toMillis();
        if (timeout < 1000 || timeout > 86400000) {
            throw new IllegalStateException("Hosted approval timeout must be between 1s and 24h;"
                    + " a suffix-less number binds as seconds, so write 300s rather than 300000");
        }
        String mode = harness.getApprovalMode();
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
                        || !LocalProcessRuntimeProvisioner.KIND.equals(runtimeBroker.getProvisioner())
                        || !WorkspaceExecutionProfile.admitsIsolationClass(runtimeBroker.getIsolationClass())
                        || (runtimeBroker.getWorkspaceMounts().isEmpty()
                                && runtimeBroker.getWorkspaceCreationRoot().isBlank())
                        || mode == null
                        || !Set.of("yolo", "default", "auto-edit")
                                .contains(
                                        mode.toLowerCase(Locale.ROOT)))) {
            throw new IllegalStateException(
                    "Hosted Workspace files require"
                            + " a supported Harness, Session Store and Session-isolated"
                            + " local-process Broker with Workspace mounts");
        }
        if (!runtimeBroker.getWorkspaceCreationRoot().isBlank()
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
            if (!(automation.getScanDelay().toMillis() > 0)
                    || !(automation.getLease().toMillis() > 0)
                    || !(automation.getLateTolerance().toMillis() > 0)
                    || !(automation.getLookback().toMillis() > 0)) {
                throw new IllegalStateException(
                        "Automation scan-delay, lease, late-tolerance and lookback must be positive durations.");
            }
        }
        // The child Workspace capability (#13753 I1) runs Git in this
        // control plane against an administrator mount, so it needs the
        // local-process Broker that mounts the storage here.
        if (runtimeBroker.isChildWorkspacesEnabled()) {
            // A merge runs once the child Session is closed (#13753 I2), and
            // only a durable local-process Broker can close one.
            if (!runtimeBroker.isEnabled()
                    || !LocalProcessRuntimeProvisioner.KIND.equals(runtimeBroker.getProvisioner())
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

    public static class Harness {
        private boolean enabled;
        private boolean workspaceFilesEnabled;
        private boolean workspaceShellEnabled;
        private String baseUrl = "http://127.0.0.1:4170";
        private String token = "";
        private String capabilityDigest = "";
        private String approvalMode = "yolo";
        // Unit-less operator overrides must bind in the annotated unit; an
        // un-annotated Duration silently binds milliseconds.
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration approvalTimeout = Duration.ofMinutes(10);

        public Duration getApprovalTimeout() {
            return approvalTimeout;
        }

        public void setApprovalTimeout(Duration value) {
            approvalTimeout = value;
        }

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

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public boolean isWorkspaceFilesEnabled() {
            return workspaceFilesEnabled;
        }

        public void setWorkspaceFilesEnabled(boolean workspaceFilesEnabled) {
            this.workspaceFilesEnabled = workspaceFilesEnabled;
        }

        public boolean isWorkspaceShellEnabled() {
            return workspaceShellEnabled;
        }

        public void setWorkspaceShellEnabled(boolean workspaceShellEnabled) {
            this.workspaceShellEnabled = workspaceShellEnabled;
        }

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }

        public String getCapabilityDigest() {
            return capabilityDigest;
        }

        public void setCapabilityDigest(String capabilityDigest) {
            this.capabilityDigest = capabilityDigest;
        }

        public String getApprovalMode() {
            return approvalMode;
        }

        public Duration getLoadTimeout() {
            return loadTimeout;
        }

        public void setLoadTimeout(Duration value) {
            loadTimeout = value;
        }

        public void setApprovalMode(String approvalMode) {
            this.approvalMode = approvalMode;
        }

        public Duration getConnectTimeout() {
            return connectTimeout;
        }

        public void setConnectTimeout(Duration connectTimeout) {
            this.connectTimeout = connectTimeout;
        }

        public Duration getRequestTimeout() {
            return requestTimeout;
        }

        public void setRequestTimeout(Duration requestTimeout) {
            this.requestTimeout = requestTimeout;
        }

        public Duration getHeartbeatInterval() {
            return heartbeatInterval;
        }

        public void setHeartbeatInterval(Duration heartbeatInterval) {
            this.heartbeatInterval = heartbeatInterval;
        }

        public Duration getTurnDeadline() {
            return turnDeadline;
        }

        public void setTurnDeadline(Duration turnDeadline) {
            this.turnDeadline = turnDeadline;
        }
    }

    public static class SessionStore {
        private boolean enabled;
        private String baseUrl = "";
        private String workspaceId = "";
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration writerLeaseDuration = Duration.ofSeconds(60);
        private String bindingKey = "";
        private boolean allowInsecureHttp;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getWorkspaceId() {
            return workspaceId;
        }

        public void setWorkspaceId(String workspaceId) {
            this.workspaceId = workspaceId;
        }

        public Duration getWriterLeaseDuration() {
            return writerLeaseDuration;
        }

        public void setWriterLeaseDuration(Duration writerLeaseDuration) {
            this.writerLeaseDuration = writerLeaseDuration;
        }

        public String getBindingKey() {
            return bindingKey;
        }

        public void setBindingKey(String bindingKey) {
            this.bindingKey = bindingKey;
        }

        public boolean isAllowInsecureHttp() {
            return allowInsecureHttp;
        }

        public void setAllowInsecureHttp(boolean allowInsecureHttp) {
            this.allowInsecureHttp = allowInsecureHttp;
        }
    }

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

        public String getMode() {
            return mode;
        }

        public void setMode(String mode) {
            this.mode = mode;
        }

        public String getSigningKey() {
            return signingKey;
        }

        public void setSigningKey(String signingKey) {
            this.signingKey = signingKey;
        }

        public long getMaxSignedBodyBytes() {
            return maxSignedBodyBytes;
        }

        public void setMaxSignedBodyBytes(long maxSignedBodyBytes) {
            this.maxSignedBodyBytes = maxSignedBodyBytes;
        }

        public Duration getAllowedDrift() {
            return allowedDrift;
        }

        public void setAllowedDrift(Duration allowedDrift) {
            this.allowedDrift = allowedDrift;
        }

        public boolean isAllowInsecureBind() {
            return allowInsecureBind;
        }

        public void setAllowInsecureBind(boolean allowInsecureBind) {
            this.allowInsecureBind = allowInsecureBind;
        }
    }

    public static class InternalServer {
        private int port;
        private String address = "127.0.0.1";

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }

        // A blank value comes from an unset template variable; both the
        // startup guard and the connector must read it as the default.
        public String getAddress() {
            return StringUtils.isBlank(address) ? "127.0.0.1"
                    : address;
        }

        public void setAddress(String address) {
            this.address = address;
        }
    }

    public static class ToolPublication {
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
        // Off by default: the head's activation columns are only trustworthy
        // once no pre-V36 binary can still commit. Enable after the fleet
        // fully runs the schema's version.
        private boolean journalHeadAuthorization;

        public boolean isJournalHeadAuthorization() { return journalHeadAuthorization; }
        public boolean isAsyncVerificationEnabled() { return asyncVerificationEnabled; }
        public void setAsyncVerificationEnabled(boolean value) { asyncVerificationEnabled = value; }
        public int getVerificationConcurrency() { return verificationConcurrency; }
        public void setVerificationConcurrency(int value) { verificationConcurrency = value; }
        public void setJournalHeadAuthorization(boolean value) { journalHeadAuthorization = value; }
        public boolean isGcEnabled() { return gcEnabled; }
        public void setGcEnabled(boolean value) { gcEnabled = value; }
        public Duration getDeletionGrace() { return deletionGrace; }
        public void setDeletionGrace(Duration value) { deletionGrace = value; }

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public String getOssEndpoint() { return ossEndpoint; }
        public void setOssEndpoint(String value) { ossEndpoint = value; }
        public String getOssRegion() { return ossRegion; }
        public void setOssRegion(String value) { ossRegion = value; }
        public String getOssBucket() { return ossBucket; }
        public void setOssBucket(String value) { ossBucket = value; }
        public String getServiceBaseUrl() { return serviceBaseUrl; }
        public void setServiceBaseUrl(String value) { serviceBaseUrl = value; }
        public Long getExecutionBytes() { return executionBytes; }
        public void setExecutionBytes(Long value) { executionBytes = value; }
        public Long getSessionBytes() { return sessionBytes; }
        public void setSessionBytes(Long value) { sessionBytes = value; }
        public Long getTenantBytes() { return tenantBytes; }
        public void setTenantBytes(Long value) { tenantBytes = value; }
        public Long getActiveCaptures() { return activeCaptures; }
        public void setActiveCaptures(Long value) { activeCaptures = value; }
        public Integer getEntryConcurrency() { return entryConcurrency; }
        public void setEntryConcurrency(Integer value) { entryConcurrency = value; }
        public Duration getOperationTimeout() { return operationTimeout; }
        public void setOperationTimeout(Duration value) { operationTimeout = value; }
        public Duration getClaimTimeout() { return claimTimeout; }
        public void setClaimTimeout(Duration value) { claimTimeout = value; }
        public Long getVerificationBytesPerSecond() { return verificationBytesPerSecond; }
        public void setVerificationBytesPerSecond(Long value) { verificationBytesPerSecond = value; }
        public Duration getMaxVerificationTimeout() { return maxVerificationTimeout; }
        public void setMaxVerificationTimeout(Duration value) { maxVerificationTimeout = value; }
    }

    public static class Artifacts {
        private boolean enabled;
        private boolean publishOriginal;
        private boolean publishPreview;
        private int maxConcurrentReads = 4;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readTimeout = Duration.ofMinutes(2);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readRevalidationInterval = Duration.ofSeconds(5);

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean value) { enabled = value; }
        public boolean isPublishOriginal() { return publishOriginal; }
        public void setPublishOriginal(boolean value) { publishOriginal = value; }
        public boolean isPublishPreview() { return publishPreview; }
        public void setPublishPreview(boolean value) { publishPreview = value; }
        public int getMaxConcurrentReads() { return maxConcurrentReads; }
        public void setMaxConcurrentReads(int value) { maxConcurrentReads = value; }
        public Duration getReadTimeout() { return readTimeout; }
        public void setReadTimeout(Duration value) { readTimeout = value; }
        /** How often a download re-verifies content access; PT0S checks on every chunk. */
        public Duration getReadRevalidationInterval() { return readRevalidationInterval; }
        public void setReadRevalidationInterval(Duration value) { readRevalidationInterval = value; }
    }

    public static class Dispatch {
        // No typed scan-delay field. The deployed default comes from
        // application.yml (`dispatch.scan-delay: '1s'`); the same
        // "${...scan-delay:1s}" fallback is repeated by three @Scheduled
        // methods — ActionResponseCoordinator.recover,
        // HarnessCoordinator.recoverExpiredTurns and
        // SessionLifecycleCoordinator.recoverOperations — and @Scheduled
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

        public Duration getLeaseDuration() {
            return leaseDuration;
        }

        public void setLeaseDuration(Duration leaseDuration) {
            this.leaseDuration = leaseDuration;
        }

        public Duration getLeaseRenewInterval() {
            return leaseRenewInterval;
        }

        public void setLeaseRenewInterval(Duration leaseRenewInterval) {
            this.leaseRenewInterval = leaseRenewInterval;
        }

        public Duration getRetryInitialDelay() {
            return retryInitialDelay;
        }

        public void setRetryInitialDelay(Duration retryInitialDelay) {
            this.retryInitialDelay = retryInitialDelay;
        }

        public Duration getRetryMaxDelay() {
            return retryMaxDelay;
        }

        public void setRetryMaxDelay(Duration retryMaxDelay) {
            this.retryMaxDelay = retryMaxDelay;
        }

        public int getMaxPreAdmissionRetries() {
            return maxPreAdmissionRetries;
        }

        public void setMaxPreAdmissionRetries(int maxPreAdmissionRetries) {
            this.maxPreAdmissionRetries = maxPreAdmissionRetries;
        }
    }

    public static class Events {
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration pollInterval = Duration.ofSeconds(5);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration heartbeatInterval = Duration.ofSeconds(15);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration streamTimeout = Duration.ofMinutes(30);
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration readGrantRecheckInterval = Duration.ofSeconds(5);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration batchInterval = Duration.ofMillis(75);
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration materializeInterval = Duration.ofMillis(100);
        private int batchMaxEvents = 64;
        private int batchMaxBytes = 65536;
        private boolean replayFloorEnabled;

        public Duration getPollInterval() {
            return pollInterval;
        }

        public void setPollInterval(Duration pollInterval) {
            this.pollInterval = pollInterval;
        }

        /**
         * How often a stream re-verifies the subscriber's read grant; PT0S
         * checks before every event.
         */
        public Duration getReadGrantRecheckInterval() {
            return readGrantRecheckInterval;
        }

        public void setReadGrantRecheckInterval(
                Duration readGrantRecheckInterval) {
            this.readGrantRecheckInterval = readGrantRecheckInterval;
        }

        public Duration getHeartbeatInterval() {
            return heartbeatInterval;
        }

        public void setHeartbeatInterval(Duration heartbeatInterval) {
            this.heartbeatInterval = heartbeatInterval;
        }

        public Duration getStreamTimeout() {
            return streamTimeout;
        }

        public void setStreamTimeout(Duration streamTimeout) {
            this.streamTimeout = streamTimeout;
        }

        public Duration getBatchInterval() {
            return batchInterval;
        }

        public void setBatchInterval(Duration batchInterval) {
            this.batchInterval = batchInterval;
        }

        public Duration getMaterializeInterval() {
            return materializeInterval;
        }

        public void setMaterializeInterval(Duration materializeInterval) {
            this.materializeInterval = materializeInterval;
        }

        public int getBatchMaxEvents() {
            return batchMaxEvents;
        }

        public void setBatchMaxEvents(int batchMaxEvents) {
            this.batchMaxEvents = batchMaxEvents;
        }

        public int getBatchMaxBytes() {
            return batchMaxBytes;
        }

        public void setBatchMaxBytes(int batchMaxBytes) {
            this.batchMaxBytes = batchMaxBytes;
        }

        /**
         * Whether the scheduled pass raises each Session's replay floor as
         * far as its Snapshot proves safe. Disabled by default; events are
         * never deleted here either way.
         */
        public boolean isReplayFloorEnabled() {
            return replayFloorEnabled;
        }

        public void setReplayFloorEnabled(boolean replayFloorEnabled) {
            this.replayFloorEnabled = replayFloorEnabled;
        }
    }

    public static class RuntimeBroker {
        private boolean enabled;
        private final Retention retention = new Retention();
        private String host = "127.0.0.1";
        private int port = 4182;
        private boolean allowNonLoopback;
        private String token = "";
        private String provisioner = LocalProcessRuntimeProvisioner.KIND;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration v3ResultWindow = Duration.ofMinutes(30);
        private String workspaceId = "";
        private String workspaceGeneration = "1";
        private String workspaceCwd = "";
        private List<WorkspaceMount> workspaceMounts = List.of();
        private String workspaceCreationRoot = "";
        private String isolationClass = "session";
        private String stateDirectory = "";
        private boolean durableLocalProcess = true;
        private boolean trustedLocalRebootRecovery = true;
        private boolean operatorRecoveryEnabled;
        private boolean verifiedWorkspaceRecoveryEnabled;
        private String credentialKeyId = "";
        private String credentialKey = "";
        private String nodeExecutable = "";
        private String workerEntry = "";
        private String staticEndpoint = "";
        private String staticToken = "";
        private String staticRuntimeInstanceId = "standalone-runtime";
        private String staticLeaseId = "standalone-lease";
        private long staticEpoch = 1;
        private Map<String, String> environment = new LinkedHashMap<>();
        private boolean childWorkspacesEnabled;
        private String childWorkspaceGit = "git";
        @DurationUnit(ChronoUnit.MILLIS)
        private Duration childWorkspaceGitTimeout = Duration.ofMinutes(2);

        public Retention getRetention() {
            return retention;
        }

        public static class Retention {
            private boolean enabled;
            @DurationUnit(ChronoUnit.DAYS)
            private Duration maxAge = Duration.ofDays(30);
            private int batchSize = 100;
            @DurationUnit(ChronoUnit.MILLIS)
            private Duration scanDelay = Duration.ofMinutes(1);

            public boolean isEnabled() { return enabled; }
            public void setEnabled(boolean value) { enabled = value; }
            public Duration getMaxAge() { return maxAge; }
            public void setMaxAge(Duration value) { maxAge = value; }
            public int getBatchSize() { return batchSize; }
            public void setBatchSize(int value) { batchSize = value; }
            public Duration getScanDelay() { return scanDelay; }
            public void setScanDelay(Duration value) { scanDelay = value; }

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

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public String getHost() {
            return host;
        }

        public void setHost(String host) {
            this.host = host;
        }

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }

        public boolean isAllowNonLoopback() {
            return allowNonLoopback;
        }

        public void setAllowNonLoopback(boolean allowNonLoopback) {
            this.allowNonLoopback = allowNonLoopback;
        }

        public Duration getV3ResultWindow() {
            return v3ResultWindow;
        }

        public void setV3ResultWindow(Duration v3ResultWindow) {
            this.v3ResultWindow = v3ResultWindow;
        }

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }

        public String getProvisioner() {
            return provisioner;
        }

        public void setProvisioner(String provisioner) {
            this.provisioner = provisioner;
        }

        public String getWorkspaceId() {
            return workspaceId;
        }

        public void setWorkspaceId(String workspaceId) {
            this.workspaceId = workspaceId;
        }

        public String getWorkspaceGeneration() {
            return workspaceGeneration;
        }

        public void setWorkspaceGeneration(String workspaceGeneration) {
            this.workspaceGeneration = workspaceGeneration;
        }

        public String getWorkspaceCwd() {
            return workspaceCwd;
        }

        public void setWorkspaceCwd(String workspaceCwd) {
            this.workspaceCwd = workspaceCwd;
        }

        public String getIsolationClass() {
            return isolationClass;
        }

        public List<WorkspaceMount> getWorkspaceMounts() {
            return workspaceMounts;
        }

        public void setWorkspaceMounts(List<WorkspaceMount> workspaceMounts) {
            this.workspaceMounts = workspaceMounts;
        }

        public String getWorkspaceCreationRoot() {
            return workspaceCreationRoot;
        }

        public void setWorkspaceCreationRoot(String workspaceCreationRoot) {
            this.workspaceCreationRoot = workspaceCreationRoot;
        }

        public record WorkspaceMount(String tenantId, String storageId, String root) {
        }

        public void setIsolationClass(String isolationClass) {
            this.isolationClass = isolationClass;
        }

        public boolean isDurableLocalProcess() {
            return durableLocalProcess;
        }

        public void setDurableLocalProcess(boolean durableLocalProcess) {
            this.durableLocalProcess = durableLocalProcess;
        }

        public boolean isTrustedLocalRebootRecovery() {
            return trustedLocalRebootRecovery;
        }

        public void setTrustedLocalRebootRecovery(boolean trustedLocalRebootRecovery) {
            this.trustedLocalRebootRecovery = trustedLocalRebootRecovery;
        }

        public boolean isOperatorRecoveryEnabled() {
            return operatorRecoveryEnabled;
        }

        public void setOperatorRecoveryEnabled(boolean operatorRecoveryEnabled) {
            this.operatorRecoveryEnabled = operatorRecoveryEnabled;
        }

        public boolean isVerifiedWorkspaceRecoveryEnabled() {
            return verifiedWorkspaceRecoveryEnabled;
        }

        public boolean isChildWorkspacesEnabled() {
            return childWorkspacesEnabled;
        }

        public void setChildWorkspacesEnabled(boolean childWorkspacesEnabled) {
            this.childWorkspacesEnabled = childWorkspacesEnabled;
        }

        public String getChildWorkspaceGit() {
            return childWorkspaceGit;
        }

        public void setChildWorkspaceGit(String childWorkspaceGit) {
            this.childWorkspaceGit = childWorkspaceGit;
        }

        public Duration getChildWorkspaceGitTimeout() {
            return childWorkspaceGitTimeout;
        }

        public void setChildWorkspaceGitTimeout(Duration childWorkspaceGitTimeout) {
            this.childWorkspaceGitTimeout = childWorkspaceGitTimeout;
        }

        public void setVerifiedWorkspaceRecoveryEnabled(boolean verifiedWorkspaceRecoveryEnabled) {
            this.verifiedWorkspaceRecoveryEnabled = verifiedWorkspaceRecoveryEnabled;
        }

        public String getStateDirectory() {
            return stateDirectory;
        }

        public void setStateDirectory(String stateDirectory) {
            this.stateDirectory = stateDirectory;
        }

        public String getCredentialKeyId() {
            return credentialKeyId;
        }

        public void setCredentialKeyId(String credentialKeyId) {
            this.credentialKeyId = credentialKeyId;
        }

        public String getCredentialKey() {
            return credentialKey;
        }

        public void setCredentialKey(String credentialKey) {
            this.credentialKey = credentialKey;
        }

        public String getNodeExecutable() {
            return nodeExecutable;
        }

        public void setNodeExecutable(String nodeExecutable) {
            this.nodeExecutable = nodeExecutable;
        }

        public String getWorkerEntry() {
            return workerEntry;
        }

        public void setWorkerEntry(String workerEntry) {
            this.workerEntry = workerEntry;
        }

        public String getStaticEndpoint() {
            return staticEndpoint;
        }

        public void setStaticEndpoint(String staticEndpoint) {
            this.staticEndpoint = staticEndpoint;
        }

        public String getStaticToken() {
            return staticToken;
        }

        public void setStaticToken(String staticToken) {
            this.staticToken = staticToken;
        }

        public String getStaticRuntimeInstanceId() {
            return staticRuntimeInstanceId;
        }

        public void setStaticRuntimeInstanceId(
                String staticRuntimeInstanceId) {
            this.staticRuntimeInstanceId = staticRuntimeInstanceId;
        }

        public String getStaticLeaseId() {
            return staticLeaseId;
        }

        public void setStaticLeaseId(String staticLeaseId) {
            this.staticLeaseId = staticLeaseId;
        }

        public long getStaticEpoch() {
            return staticEpoch;
        }

        public void setStaticEpoch(long staticEpoch) {
            this.staticEpoch = staticEpoch;
        }

        public Map<String, String> getEnvironment() {
            return environment;
        }

        public void setEnvironment(Map<String, String> environment) {
            this.environment = environment;
        }
    }

    /** H6b/H6c: the automation scanner, its lease and the slot window. */
    public static class Automation {
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

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public Duration getScanDelay() {
            return scanDelay;
        }

        public void setScanDelay(Duration scanDelay) {
            this.scanDelay = scanDelay;
        }

        public Duration getLease() {
            return lease;
        }

        public void setLease(Duration lease) {
            this.lease = lease;
        }

        public Duration getLateTolerance() {
            return lateTolerance;
        }

        public void setLateTolerance(Duration lateTolerance) {
            this.lateTolerance = lateTolerance;
        }

        public Duration getLookback() {
            return lookback;
        }

        public void setLookback(Duration lookback) {
            this.lookback = lookback;
        }

        public int getMaxSlotsPerTick() {
            return maxSlotsPerTick;
        }

        public void setMaxSlotsPerTick(int maxSlotsPerTick) {
            this.maxSlotsPerTick = maxSlotsPerTick;
        }

        public int getConcurrency() {
            return concurrency;
        }

        public void setConcurrency(int concurrency) {
            this.concurrency = concurrency;
        }
    }

    /** H5b/H5c: the trusted channel adapter surface and its claim lease. */
    public static class Channels {
        // No typed scan-delay field. The deployed default comes from
        // application.yml (`channels.scan-delay: '30s'`); the same
        // "${...channels.scan-delay:30s}" fallback drives
        // ManagedChannelService.reconcile, and @Scheduled reads a bare
        // number as milliseconds, not seconds.
        private boolean enabled;
        @DurationUnit(ChronoUnit.SECONDS)
        private Duration claimLease = Duration.ofMinutes(10);

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public Duration getClaimLease() {
            return claimLease;
        }

        public void setClaimLease(Duration claimLease) {
            this.claimLease = claimLease;
        }
    }

    /**
     * Broker-backed EventTransport (design
     * 2026-10-04-managed-agent-event-transport): the authoritative journal
     * wire (phase MQ2b), and the public-event wire and the wake and
     * materialization consumers (phase MQ2c). Default off, so a flag-off
     * deployment creates no transport, producer or consumer bean and stays
     * byte-identical. The topic must be a LITE topic, and the
     * capability-probe, wake-bootstrap and owner groups must be pre-created
     * as LITE groups bound to it — see EventTransportConfiguration for the
     * deployment prerequisites.
     */
    public static class EventTransport {
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

        public String getCapabilityProbeGroup() {
            return capabilityProbeGroup;
        }

        public void setCapabilityProbeGroup(String capabilityProbeGroup) {
            this.capabilityProbeGroup = capabilityProbeGroup;
        }

        public String getWakeBootstrapLiteTopic() {
            return wakeBootstrapLiteTopic;
        }

        public void setWakeBootstrapLiteTopic(String wakeBootstrapLiteTopic) {
            this.wakeBootstrapLiteTopic = wakeBootstrapLiteTopic;
        }

        public String getWakeBootstrapGroup() {
            return wakeBootstrapGroup;
        }

        public void setWakeBootstrapGroup(String wakeBootstrapGroup) {
            this.wakeBootstrapGroup = wakeBootstrapGroup;
        }

        public String getOwnerGroup() {
            return ownerGroup;
        }

        public void setOwnerGroup(String ownerGroup) {
            this.ownerGroup = ownerGroup;
        }

        public Duration getOwnerReconcileInterval() {
            return ownerReconcileInterval;
        }

        public void setOwnerReconcileInterval(
                Duration ownerReconcileInterval) {
            this.ownerReconcileInterval = ownerReconcileInterval;
        }

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public String getEndpoints() {
            return endpoints;
        }

        public void setEndpoints(String endpoints) {
            this.endpoints = endpoints;
        }

        public String getTopic() {
            return topic;
        }

        public void setTopic(String topic) {
            this.topic = topic;
        }
    }
}
