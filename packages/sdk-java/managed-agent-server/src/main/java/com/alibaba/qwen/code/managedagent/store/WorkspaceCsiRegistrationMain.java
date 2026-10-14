package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

public final class WorkspaceCsiRegistrationMain {
    private WorkspaceCsiRegistrationMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 4 && "render-protection".equals(args[0])) {
            if (!args[2].matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
                    || !args[3].matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
                throw new IllegalArgumentException("Fixed protection object names are required");
            }
            var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
            byte[] bytes;
            try (var input = Files.newInputStream(Path.of(args[1]))) {
                bytes = input.readNBytes(16 * 1024 + 1);
            }
            if (bytes.length == 0 || bytes.length > 16 * 1024) {
                throw new IllegalArgumentException("Bounded registration is required");
            }
            var registration = json.readValue(bytes, WorkspaceCsiRegistration.class);
            System.out.println(json.writeValueAsString(java.util.Map.of("apiVersion", "v1", "kind", "List", "items",
                    java.util.List.of(com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard.policy(registration, args[2]),
                            com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard.binding(args[2], args[3])))));
            return;
        }
        if (args.length != 2 || (!"register".equals(args[0]) && !"inspect".equals(args[0]))) {
            throw new IllegalArgumentException("Usage: (register|inspect) <reviewed-registration-json> | render-protection <reviewed-registration-json> <policy-name> <binding-name>");
        }
        String url = System.getenv("K2_JDBC_URL");
        String user = System.getenv("K2_JDBC_USER");
        String password = System.getenv("K2_JDBC_PASSWORD");
        if (url == null || url.isBlank() || user == null || user.isBlank() || password == null) {
            throw new IllegalStateException("K2_JDBC_URL, K2_JDBC_USER and K2_JDBC_PASSWORD are required");
        }
        ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
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
        var dataSource = new DriverManagerDataSource(url, user, password);
        var store = new WorkspaceCsiReservationStore(new JdbcTemplate(dataSource),
                new DataSourceTransactionManager(dataSource), json);
        if ("register".equals(args[0])) {
            store.register(registration);
            System.out.println("CSI registration persisted; mounting remains disabled.");
        } else {
            var reservation = store.inspect(registration);
            System.out.println("CSI phase=" + reservation.phase() + " revision=" + reservation.revision());
        }
    }
}
