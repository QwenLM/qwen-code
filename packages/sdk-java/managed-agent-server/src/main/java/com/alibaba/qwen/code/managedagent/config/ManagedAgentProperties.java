package com.alibaba.qwen.code.managedagent.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("qwen.managed-agent")
public class ManagedAgentProperties {
    private final Harness harness = new Harness();
    private final Dispatch dispatch = new Dispatch();
    private final Events events = new Events();
    private final RuntimeBroker runtimeBroker = new RuntimeBroker();

    public Harness getHarness() {
        return harness;
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

    public static class Harness {
        private boolean enabled;
        private String baseUrl = "http://127.0.0.1:4170";
        private String token = "";
        private String capabilityDigest = "";
        private String approvalMode = "yolo";
        private Duration connectTimeout = Duration.ofSeconds(5);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private Duration heartbeatInterval = Duration.ofSeconds(30);

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
    }

    public static class Dispatch {
        private Duration scanDelay = Duration.ofSeconds(1);
        private Duration leaseDuration = Duration.ofSeconds(60);
        private Duration leaseRenewInterval = Duration.ofSeconds(20);

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
    }

    public static class Events {
        private Duration pollInterval = Duration.ofMillis(200);
        private Duration heartbeatInterval = Duration.ofSeconds(15);
        private Duration streamTimeout = Duration.ofMinutes(30);

        public Duration getPollInterval() {
            return pollInterval;
        }

        public void setPollInterval(Duration pollInterval) {
            this.pollInterval = pollInterval;
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
    }

    public static class RuntimeBroker {
        private boolean enabled;
        private String host = "127.0.0.1";
        private int port = 4190;
        private String token = "";
        private String provisioner = "local-process";
        private String workspaceId = "";
        private String workspaceGeneration = "1";
        private String workspaceCwd = "";
        private String isolationClass = "session";
        private String stateDirectory = "";
        private String nodeExecutable = "";
        private String workerEntry = "";
        private String cliEntry = "";
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

        public void setIsolationClass(String isolationClass) {
            this.isolationClass = isolationClass;
        }

        public String getStateDirectory() {
            return stateDirectory;
        }

        public void setStateDirectory(String stateDirectory) {
            this.stateDirectory = stateDirectory;
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
