package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Created;
import com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Request;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.file.Files;
import java.nio.file.Path;

/** Offline private CREATE only; no worker, Harness, or public CSI selection. */
public final class WorkspaceCsiSessionMain {
    private WorkspaceCsiSessionMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"create".equals(args[0])) {
            throw new IllegalArgumentException("Usage: create <reviewed-csi-session-json>");
        }
        ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        Request request = readRequest(Path.of(args[1]), json);
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision(required("K2_AGENT_REVISION"));
        Created created = create(new ManagedSchemaJdbcTemplate(source), new DataSourceTransactionManager(source),
                json, properties, request);
        System.out.println(json.writeValueAsString(created));
    }

    static Request readRequest(Path path, ObjectMapper json) {
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(32 * 1024 + 1);
            if (bytes.length > 32 * 1024) {
                throw new IllegalArgumentException("CSI Session request exceeds its size limit");
            }
            Request request = json.readValue(bytes, Request.class);
            if (request == null) {
                throw new IllegalArgumentException("CSI Session request is required");
            }
            return request;
        } catch (Exception error) {
            throw new IllegalArgumentException("CSI Session request could not be read");
        }
    }

    static Created create(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ObjectMapper json, ManagedAgentProperties properties, Request request) {
        return com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiSessionCommands.create(
                jdbc, manager, json, properties, request, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
