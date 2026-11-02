package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceRecoveryStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check;
import static com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.text;

/** Private offline entry; it never boots the application or a Runtime. */
public final class WorkspaceRecoveryMain {
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    private WorkspaceRecoveryMain() {
    }

    public static void main(String[] args) throws Exception {
        check(args.length >= 2 && Set.of("capture", "verify", "inspect").contains(args[0])
                && ("inspect".equals(args[0]) ? args.length == 2
                        : args.length == 3 && "--offline-confirmed".equals(args[2])), "invalid_arguments");
        Path input = Path.of(args[1]);
        check(Files.isRegularFile(input, LinkOption.NOFOLLOW_LINKS) && Files.size(input) <= 1024 * 1024,
                "invalid_request_file");
        byte[] bytes = Files.readAllBytes(input);
        JsonNode request = com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.parse(bytes);
        com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient oss = null;
        // The private RPC loop is single-threaded; transactions still commit separately.
        try (var source = new SingleConnectionDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"),
                requiredPresent("W1_JDBC_PASSWORD"), true)) {
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            var properties = new ManagedAgentProperties();
            properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
            if (!"inspect".equals(args[0])) {
                properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                        new WorkspaceMount(text(request, "tenantId"), text(request, "storageId"), text(request, "sourceRoot"))));
            }
            ToolPublicationObjectStore objects = null;
            if ("capture".equals(args[0]) && System.getenv("W1_OSS_ENDPOINT") != null) {
                URI endpoint = URI.create(required("W1_OSS_ENDPOINT"));
                String region = required("W1_OSS_REGION");
                check("https".equals(endpoint.getScheme()) && ("oss-" + region + ".aliyuncs.com").equals(endpoint.getHost())
                        && (endpoint.getRawPath() == null || endpoint.getRawPath().isEmpty())
                        && endpoint.getRawQuery() == null && endpoint.getRawUserInfo() == null, "invalid_oss_endpoint");
                oss = com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient.regional(endpoint, region);
                objects = oss.objects(required("W1_OSS_BUCKET"));
            }
            var store = new WorkspaceRecoveryStore(jdbc, manager, new WorkspaceStorageGuard(jdbc, manager, properties, new com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader()),
                    objects, args[0], bytes);
            JsonNode existing = store.inspect();
            if ("inspect".equals(args[0]) || Set.of("SEALED", "VERIFIED").contains(existing.path("state").asText())) {
                System.out.println(existing);
                return;
            }
            new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalRecoveryWorker().execute(request, store, store::call);
            System.out.println(store.inspect());
        } finally {
            if (oss != null) {
                oss.shutdown();
            }
        }
    }

    private static String required(String name) {
        String value = requiredPresent(name);
        check(!value.isBlank(), "missing_environment");
        return value;
    }

    private static String requiredPresent(String name) {
        String value = System.getenv(name);
        check(value != null, "missing_environment");
        return value;
    }
}
