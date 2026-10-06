package com.alibaba.qwen.code.managedagent.config;

import jakarta.annotation.PostConstruct;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import java.util.Locale;
import java.util.Set;

@ConfigurationProperties("qwen.managed-agent")
public class ManagedAgentProperties {
    private final Harness harness = new Harness();
    private final SessionStore sessionStore = new SessionStore();
    private final ToolPublication toolPublication = new ToolPublication();
    private final Artifacts artifacts = new Artifacts();
    private final Dispatch dispatch = new Dispatch();
    private final Events events = new Events();
    private final RuntimeBroker runtimeBroker = new RuntimeBroker();
    private final Auth auth = new Auth();
    private final InternalServer internalServer = new InternalServer();
    private String agentRevision = "1";
    private String trustedActorHeader = "";

    public Harness getHarness() {
        return harness;
    }

    public Auth getAuth() {
        return auth;
    }

    public InternalServer getInternalServer() {
        return internalServer;
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

    public String getTrustedActorHeader() {
        return trustedActorHeader;
    }

    public void setTrustedActorHeader(String trustedActorHeader) {
        this.trustedActorHeader = trustedActorHeader;
    }

    @PostConstruct
    void validateWorkspaceFiles() {
        long timeout = harness.getApprovalTimeout().toMillis();
        if (timeout < 1000 || timeout > 86400000) {
            throw new IllegalStateException("Hosted approval timeout must be between 1s and 24h");
        }
        if (harness.isWorkspaceFilesEnabled()
                && (!harness.isEnabled()
                        || !sessionStore.isEnabled()
                        || !runtimeBroker.isEnabled()
                        || !"local-process".equals(runtimeBroker.getProvisioner())
                        || !"session".equals(runtimeBroker.getIsolationClass())
                        || runtimeBroker.getWorkspaceMounts().isEmpty()
                        || !Set.of("yolo", "default", "auto-edit")
                                .contains(
                                        harness.getApprovalMode()
                                                .toLowerCase(Locale.ROOT)))) {
            throw new IllegalStateException(
                    "Hosted Workspace files require"
                            + " a supported Harness, Session Store and Session-isolated"
                            + " local-process Broker with Workspace mounts");
        }
    }

    public static class Harness {
        private boolean enabled;
        private boolean workspaceFilesEnabled;
        private String baseUrl = "http://127.0.0.1:4170";
        private String token = "";
        private String capabilityDigest = "";
        private String approvalMode = "yolo";
        private Duration approvalTimeout = Duration.ofMinutes(10);

        public Duration getApprovalTimeout() {
            return approvalTimeout;
        }

        public void setApprovalTimeout(Duration value) {
            approvalTimeout = value;
        }

        private Duration connectTimeout = Duration.ofSeconds(5);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private Duration heartbeatInterval = Duration.ofSeconds(30);
        /**
         * Turn-level deadline passed to the Harness at prompt admission. An
         * admitted Turn outliving it is settled by the Harness as a
         * classified deadline failure, so a stalled model stream cannot pin
         * a Session forever.
         */
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
            return address == null || address.isBlank() ? "127.0.0.1"
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
        private Duration operationTimeout;
        private Duration claimTimeout;
        private Long verificationBytesPerSecond;
        private Duration maxVerificationTimeout;
        private boolean gcEnabled;
        private Duration deletionGrace = Duration.ofHours(24);
        // Off by default: the head's activation columns are only trustworthy
        // once no pre-V36 binary can still commit. Enable after the fleet
        // fully runs the schema's version.
        private boolean journalHeadAuthorization;

        public boolean isJournalHeadAuthorization() { return journalHeadAuthorization; }
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
        private Duration readTimeout = Duration.ofMinutes(2);
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
        private Duration scanDelay = Duration.ofSeconds(1);
        private Duration leaseDuration = Duration.ofSeconds(60);
        private Duration leaseRenewInterval = Duration.ofSeconds(20);
        private Duration retryInitialDelay = Duration.ofSeconds(1);
        private Duration retryMaxDelay = Duration.ofMinutes(1);
        private int maxPreAdmissionRetries = 5;

        public Duration getScanDelay() {
            return scanDelay;
        }

        public void setScanDelay(Duration scanDelay) {
            this.scanDelay = scanDelay;
        }

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
        private Duration pollInterval = Duration.ofSeconds(5);
        private Duration heartbeatInterval = Duration.ofSeconds(15);
        private Duration streamTimeout = Duration.ofMinutes(30);
        private Duration readGrantRecheckInterval = Duration.ofSeconds(5);
        private Duration batchInterval = Duration.ofMillis(75);
        private int batchMaxEvents = 64;
        private int batchMaxBytes = 65536;

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
    }

    public static class RuntimeBroker {
        private boolean enabled;
        private String host = "127.0.0.1";
        private int port = 4182;
        private boolean allowNonLoopback;
        private String token = "";
        private String provisioner = "local-process";
        private Duration v3ResultWindow = Duration.ofMinutes(30);
        private String workspaceId = "";
        private String workspaceGeneration = "1";
        private String workspaceCwd = "";
        private List<WorkspaceMount> workspaceMounts = List.of();
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
        private String cliEntry = "";
        private String kubernetesApiServer =
                "https://kubernetes.default.svc";
        private String kubernetesTokenFile =
                "/var/run/secrets/kubernetes.io/serviceaccount/token";
        private String kubernetesCaFile =
                "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
        private String kubernetesClusterUid = "";
        private String kubernetesNamespace = "qwen-runtimes";
        private String kubernetesImage = "";
        private int kubernetesPort = 4190;
        private String kubernetesServiceAccountName = "";
        private String kubernetesWorkspaceClaimName = "";
        private String staticEndpoint = "";
        private String staticToken = "";
        private String staticRuntimeInstanceId = "standalone-runtime";
        private String staticLeaseId = "standalone-lease";
        private long staticEpoch = 1;
        private Map<String, String> environment = new LinkedHashMap<>();

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

        public String getCliEntry() {
            return cliEntry;
        }

        public void setCliEntry(String cliEntry) {
            this.cliEntry = cliEntry;
        }

        public String getKubernetesApiServer() {
            return kubernetesApiServer;
        }

        public void setKubernetesApiServer(String kubernetesApiServer) {
            this.kubernetesApiServer = kubernetesApiServer;
        }

        public String getKubernetesTokenFile() {
            return kubernetesTokenFile;
        }

        public void setKubernetesTokenFile(String kubernetesTokenFile) {
            this.kubernetesTokenFile = kubernetesTokenFile;
        }

        public String getKubernetesCaFile() {
            return kubernetesCaFile;
        }

        public void setKubernetesCaFile(String kubernetesCaFile) {
            this.kubernetesCaFile = kubernetesCaFile;
        }

        public String getKubernetesClusterUid() {
            return kubernetesClusterUid;
        }

        public void setKubernetesClusterUid(String kubernetesClusterUid) {
            this.kubernetesClusterUid = kubernetesClusterUid;
        }

        public String getKubernetesNamespace() {
            return kubernetesNamespace;
        }

        public void setKubernetesNamespace(String kubernetesNamespace) {
            this.kubernetesNamespace = kubernetesNamespace;
        }

        public String getKubernetesImage() {
            return kubernetesImage;
        }

        public void setKubernetesImage(String kubernetesImage) {
            this.kubernetesImage = kubernetesImage;
        }

        public int getKubernetesPort() {
            return kubernetesPort;
        }

        public void setKubernetesPort(int kubernetesPort) {
            this.kubernetesPort = kubernetesPort;
        }

        public String getKubernetesServiceAccountName() {
            return kubernetesServiceAccountName;
        }

        public void setKubernetesServiceAccountName(
                String kubernetesServiceAccountName) {
            this.kubernetesServiceAccountName =
                    kubernetesServiceAccountName;
        }

        public String getKubernetesWorkspaceClaimName() {
            return kubernetesWorkspaceClaimName;
        }

        public void setKubernetesWorkspaceClaimName(
                String kubernetesWorkspaceClaimName) {
            this.kubernetesWorkspaceClaimName =
                    kubernetesWorkspaceClaimName;
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
}
