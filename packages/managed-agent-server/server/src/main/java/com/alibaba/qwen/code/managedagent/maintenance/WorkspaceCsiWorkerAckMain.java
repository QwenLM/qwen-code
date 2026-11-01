package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiWorkerAckStore;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;

/** Private single-publication ACK command; credentials and identity come from trusted records. */
public final class WorkspaceCsiWorkerAckMain {
    private WorkspaceCsiWorkerAckMain() {
    }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Exception failure) {
            System.err.println("Original CSI worker acknowledgement could not be completed.");
            System.exit(1);
        }
    }

    static void run(String[] args) throws Exception {
        if (args.length != 6 || !("acknowledge".equals(args[0]) || "inspect".equals(args[0]))) {
            throw new IllegalArgumentException("Usage: acknowledge|inspect <retirement> <tenant>"
                    + " <workspace> <session> <publication>");
        }
        var selector = new WorkspaceCsiWorkerAckStore.Selector(args[1], args[2], args[3], args[4], args[5]);
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"),
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var runtimeSessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var sessionStore = new ManagedSessionStore(jdbc);
        sessionStore.configureHarnessRules(new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        var grants = new ToolPublicationStore(jdbc, manager, sessionStore, executions, bindings,
                new ToolPublicationStore.Capacity(16L * 1024 * 1024, 64L * 1024 * 1024,
                        256L * 1024 * 1024, 64));
        com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient oss = "inspect".equals(args[0]) ? null : oss();
        try {
            ToolPublicationObjectStore objects = oss == null ? inlineObjects()
                    : oss.objects(required("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_BUCKET"));
            var data = new ToolPublicationDataStore(jdbc, manager, grants, sessionStore, objects,
                    Duration.ofSeconds(30), Duration.ofSeconds(10),
                    new ToolPublicationDataStore.VerificationBudget(1024 * 1024, Duration.ofMinutes(25)));
            var admission = new ToolPublicationAdmissionStore(jdbc, manager, sessionStore, data);
            var acknowledgements = new WorkspaceCsiWorkerAckStore(source, manager, bindings, runtimeSessions,
                    executions, admission, new HttpRuntimeTransport(), Duration.ofSeconds(30));
            var result = "inspect".equals(args[0]) ? acknowledgements.inspect(selector)
                    : acknowledgements.acknowledge(selector);
            System.out.println(new ObjectMapper().writeValueAsString(result));
        } finally {
            if (oss != null) {
                oss.shutdown();
            }
        }
    }

    private static com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient oss() throws Exception {
        String endpointValue = System.getenv("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_ENDPOINT");
        if (endpointValue == null && System.getenv("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_REGION") == null
                && System.getenv("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_BUCKET") == null) {
            return null;
        }
        URI endpoint = URI.create(required("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_ENDPOINT"));
        String region = required("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_REGION");
        required("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_BUCKET");
        if (!"https".equals(endpoint.getScheme()) || endpoint.getRawUserInfo() != null
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || endpoint.getPort() != -1 || endpoint.getRawPath() != null && !endpoint.getRawPath().isEmpty()
                || !endpoint.getHost().equals("oss-" + region + ".aliyuncs.com")) {
            throw new IllegalArgumentException("Private regional OSS endpoint is required");
        }
        return com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient.regional(endpoint, region);
    }

    private static ToolPublicationObjectStore inlineObjects() {
        return new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                throw new IllegalStateException("External publication objects require OSS configuration");
            }

            @Override
            public InputStream open(String key) {
                throw new IllegalStateException("External publication objects require OSS configuration");
            }

            @Override
            public void validateConfiguration() {
            }
        };
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Required CSI coordinator setting is unavailable");
        }
        return value;
    }
}
