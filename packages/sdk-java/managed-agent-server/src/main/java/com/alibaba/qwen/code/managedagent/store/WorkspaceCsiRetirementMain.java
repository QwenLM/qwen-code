package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Offline intent/seal only; never starts, stops or releases a worker. */
public final class WorkspaceCsiRetirementMain {
    private WorkspaceCsiRetirementMain() {
    }

    public static void main(String[] args) throws Exception {
        if (!(args.length == 4 && "inspect".equals(args[0]))
                && !(args.length == 7 && "begin".equals(args[0]))) {
            throw new IllegalArgumentException("Usage: inspect <registration-json> <binding> <generation>"
                    + " | begin <registration-json> <binding> <generation> <reservation> <revision> <retirement>");
        }
        ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        WorkspaceCsiRegistration registration;
        try (var input = Files.newInputStream(Path.of(args[1]))) {
            byte[] bytes = input.readNBytes(16 * 1024 + 1);
            if (bytes.length > 16 * 1024) {
                throw new IllegalArgumentException("CSI registration exceeds its size limit");
            }
            registration = json.readValue(bytes, WorkspaceCsiRegistration.class);
        } catch (Exception error) {
            throw new IllegalArgumentException("CSI registration could not be read");
        }
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"),
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var store = new WorkspaceCsiReservationStore(new JdbcTemplate(source),
                new DataSourceTransactionManager(source), json);
        RuntimeBindingRecord original = bindings.findById(args[2]);
        if (original == null || original.getGeneration() != Long.parseLong(args[3])) {
            throw new IllegalStateException("Original CSI generation is unavailable");
        }
        var prior = store.inspectRetirement(registration, bindings, original);
        if ("inspect".equals(args[0])) {
            System.out.println(json.writeValueAsString(prior));
            return;
        }
        var expected = new WorkspaceCsiReservationStore.Reservation("RESERVED", Long.parseLong(args[5]),
                args[4], registration.aliasKey(), registration.revision(), original.getBindingId(),
                original.getGeneration(), original.getProvisionSeed().getProvisionRequestId());
        String owner = "csi-retirement:" + UUID.randomUUID();
        if (prior == null) {
            original = bindings.claimOperation(original.getBindingId(), owner, Duration.ofSeconds(30));
            if (original == null) {
                throw new IllegalStateException("Original CSI coordinator claim is unavailable");
            }
        }
        try {
            System.out.println(json.writeValueAsString(store.beginRetirement(
                    registration, bindings, original, expected, args[6])));
        } finally {
            if (owner.equals(original.getOperationOwner())) {
                bindings.releaseOperation(original.getBindingId(), owner, original.getOperationGeneration());
            }
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
