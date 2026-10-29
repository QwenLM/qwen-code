package com.alibaba.qwen.code.managedagent.settings;

import java.time.Duration;
import java.util.List;
import java.util.Map;

public interface ManagedAgentSettings {
    public Harness getHarness();
    public boolean admitsPublicChildAgents();
    public Auth getAuth();
    public InternalServer getInternalServer();
    public Automation getAutomation();
    public Channels getChannels();
    public EventTransport getEventTransport();
    public SessionStore getSessionStore();
    public ToolPublication getToolPublication();
    public Artifacts getArtifacts();
    public ManagedExtensions getManagedExtensions();
    public Extensions getExtensions();
    public Dispatch getDispatch();
    public Events getEvents();
    public RuntimeBroker getRuntimeBroker();
    public String getAgentRevision();
    public List<String> getDefinitionToolProfiles();
    public List<String> getDefinitionModels();
    public List<? extends ModelOption> getModelCatalog();
    public interface ModelOption {
        public String getModelId();
        public String getLabel();
    }
    public String getTrustedActorHeader();
    public String getServiceUser();
    public boolean harnessCredentialsApplied();
    public String harnessBrokerUrl();
    public interface Harness {
        public HarnessPool getPool();
        public Duration getApprovalTimeout();
        public boolean isEnabled();
        public boolean isWorkspaceFilesEnabled();
        public boolean isWorkspaceChildAgentsEnabled();
        public boolean isWorkspaceShellEnabled();
        public String getBaseUrl();
        public String getToken();
        public String getCapabilityDigest();
        public String getCredentialsFile();
        public String getApprovalMode();
        public Duration getLoadTimeout();
        public Duration getConnectTimeout();
        public Duration getRequestTimeout();
        public Duration getHeartbeatInterval();
        public Duration getTurnDeadline();
    }
    public interface HarnessPool {
        public boolean isEnabled();
        public String getDiscovery();
        public List<? extends HarnessInstance> getInstances();
        public String getKeyStoreFile();
        public String getKeyStorePasswordFile();
        public String getTrustStoreFile();
        public String getTrustStorePasswordFile();
        public String getKubernetesApiUrl();
        public String getKubernetesTokenFile();
        public String getKubernetesCaFile();
        public String getNamespace();
        public String getServiceName();
        public String getServiceUid();
        public String getPortName();
    }
    public interface HarnessInstance {
        public String getInstanceId();
        public String getBaseUrl();
    }
    public interface SessionStore {
        public boolean isEnabled();
        public String getBaseUrl();
        public String getWorkspaceId();
        public Duration getWriterLeaseDuration();
        public String getBindingKey();
        public boolean isAllowInsecureHttp();
    }
    public interface Auth {
        public String getMode();
        public String getSigningKey();
        public long getMaxSignedBodyBytes();
        public Duration getAllowedDrift();
        public boolean isAllowInsecureBind();
    }
    public interface InternalServer {
        public int getPort();
        public String getAddress();
    }
    public interface ToolPublication {
        public boolean isAsyncVerificationEnabled();
        public int getVerificationConcurrency();
        public boolean isGcEnabled();
        public Duration getDeletionGrace();
        public boolean isEnabled();
        public String getOssEndpoint();
        public String getOssRegion();
        public String getOssBucket();
        public String getServiceBaseUrl();
        public Long getExecutionBytes();
        public Long getSessionBytes();
        public Long getTenantBytes();
        public Long getActiveCaptures();
        public Integer getEntryConcurrency();
        public Duration getOperationTimeout();
        public Duration getClaimTimeout();
        public Long getVerificationBytesPerSecond();
        public Duration getMaxVerificationTimeout();
    }
    public interface ManagedExtensions {
        public boolean isEnabled();
        public String getMode();
        public String getCacheDirectory();
        public String getCgroupRoot();
    }
    public interface Extensions {
        public boolean isEnabled();
        public String getArtifactDirectory();
        public List<String> getAllowedActors();
    }
    public interface Artifacts {
        public boolean isEnabled();
        public boolean isPublishOriginal();
        public boolean isPublishPreview();
        public int getMaxConcurrentReads();
        public Duration getReadTimeout();
        public Duration getReadRevalidationInterval();
    }
    public interface Dispatch {
        public Duration getLeaseDuration();
        public Duration getLeaseRenewInterval();
        public Duration getRetryInitialDelay();
        public Duration getRetryMaxDelay();
        public int getMaxPreAdmissionRetries();
        public int getMaxPostAdmissionRetries();
        public int getMaxOperationRetries();
    }
    public interface Events {
        public Duration getPollInterval();
        public Duration getReadGrantRecheckInterval();
        public Duration getHeartbeatInterval();
        public Duration getStreamTimeout();
        public Duration getBatchInterval();
        public Duration getMaterializeInterval();
        public int getBatchMaxEvents();
        public int getBatchMaxBytes();
        public boolean isReplayFloorEnabled();
    }
    public interface RuntimeBroker {
        public SshSettings getSsh();
        public Retention getRetention();
        public interface Retention {
            public boolean isEnabled();
            public Duration getMaxAge();
            public int getBatchSize();
            public Duration getScanDelay();
        }
        public boolean isEnabled();
        public String getHost();
        public int getPort();
        public boolean isAllowNonLoopback();
        public Duration getV3ResultWindow();
        public String getToken();
        public String getProvisioner();
        public String getWorkspaceId();
        public String getWorkspaceGeneration();
        public String getWorkspaceCwd();
        public String getIsolationClass();
        public String getBoundSessionIsolationClass();
        public boolean isSessionCreateWarm();
        public List<? extends WorkspaceMount> getWorkspaceMounts();
        public String getWorkspaceCreationRoot();
        public boolean isLocalDirectoryImportEnabled();
        public interface WorkspaceMount {
            public String tenantId();
            public String storageId();
            public String root();
        }
        public interface ResidentWorkspace {
            public String workspaceId();
            public long workspaceGeneration();
            public com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration registration();
            public com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity protection();
            public String image();
            public List<String> command();
            public List<com.alibaba.qwen.code.managedagent.contracts.runtime.WorkerArtifact> artifacts();
        }
        public List<? extends ResidentWorkspace> getResidentWorkspaces();
        public String getResidentKubernetesApiUrl();
        public String getResidentKubernetesTokenFile();
        public String getResidentKubernetesCaFile();
        public boolean isDurableLocalProcess();
        public boolean isTrustedLocalRebootRecovery();
        public boolean isOperatorRecoveryEnabled();
        public boolean isVerifiedWorkspaceRecoveryEnabled();
        public boolean isChildWorkspacesEnabled();
        public boolean isSessionWorktreesEnabled();
        public boolean isChildSnapshotsEnabled();
        public String getChildWorkspaceGit();
        public Duration getChildWorkspaceGitTimeout();
        public String getStateDirectory();
        public String getCredentialKeyId();
        public String getCredentialKey();
        public Map<String, String> getPreviousCredentialKeys();
        public String getNodeExecutable();
        public String getWorkerEntry();
        public String getStaticEndpoint();
        public String getStaticToken();
        public String getExternalProviderUrl();
        public String getExternalProviderToken();
        public String getExternalProviderId();
        public Duration getExternalRequestTimeout();
        public Duration getExternalStartupTimeout();
        public String getStaticRuntimeInstanceId();
        public String getStaticLeaseId();
        public long getStaticEpoch();
        public Map<String, String> getEnvironment();
    }
    public interface Automation {
        public boolean isEnabled();
        public Duration getScanDelay();
        public Duration getLease();
        public Duration getLateTolerance();
        public Duration getLookback();
        public int getMaxSlotsPerTick();
        public int getConcurrency();
        public int getScannerThreads();
    }
    public interface Channels {
        public boolean isEnabled();
        public Duration getClaimLease();
    }
    public interface EventTransport {
        public String getCapabilityProbeGroup();
        public String getWakeBootstrapLiteTopic();
        public String getWakeBootstrapGroup();
        public String getOwnerGroup();
        public Duration getOwnerReconcileInterval();
        public boolean isEnabled();
        public String getEndpoints();
        public String getTopic();
    }
}
