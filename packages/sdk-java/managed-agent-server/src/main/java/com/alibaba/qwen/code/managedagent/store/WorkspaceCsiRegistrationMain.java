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
        if (args.length != 2 || (!"register".equals(args[0]) && !"inspect".equals(args[0]))) {
            throw new IllegalArgumentException("Usage: (register|inspect) <reviewed-registration-json>");
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
