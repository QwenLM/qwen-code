package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.maintenance.WorkspaceRecoveryApplication;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;

import javax.sql.DataSource;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Set;

/** Trusted administrator entry; never starts the service, a worker or schema migration. */
public final class ResidentWorkspaceRetirementMain {
    private ResidentWorkspaceRetirementMain() { }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Exception failure) {
            System.err.println("Resident Workspace retirement could not be completed; inspect the original request before retrying.");
            System.exit(1);
        }
    }

    static void run(String[] args) throws Exception {
        var command = new DefaultApplicationArguments(args).getNonOptionArgs();
        if (command.size() < 2 || !Set.of("inspect", "begin", "delete-pod").contains(command.getFirst())
                || command.size() != ("delete-pod".equals(command.getFirst()) ? 3 : 2)) {
            throw new IllegalArgumentException("Expected inspect|begin <request-json> or delete-pod <request-json> <resourceVersion>.");
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        var request = readRequest(Path.of(command.get(1)), json);
        try (var context = new SpringApplicationBuilder(WorkspaceRecoveryApplication.class)
                .web(WebApplicationType.NONE).logStartupInfo(false)
                .properties("spring.main.banner-mode=off", "logging.level.root=OFF").run(args)) {
            var options = context.getBean(ManagedAgentProperties.class).getRuntimeBroker();
            var source = context.getBean(DataSource.class);
            ManagedSchema.validate(source);
            var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                    options.getCredentialKeyId(), options.getCredentialKey(), options.getPreviousCredentialKeys()));
            var store = new ResidentWorkspaceRetirementStore(new JdbcTemplate(source), new JdbcTransactionManager(source),
                    bindings, options.getResidentWorkspaces(), context.getBean(ObjectMapper.class));
            var result = switch (command.getFirst()) {
                case "inspect" -> store.inspect(request);
                case "begin" -> store.begin(request);
                case "delete-pod" -> store.deletePod(request, command.get(2), new KubernetesHttpRuntimeClient(
                        URI.create(options.getResidentKubernetesApiUrl()), Path.of(options.getResidentKubernetesTokenFile()),
                        Path.of(options.getResidentKubernetesCaFile())));
                default -> throw new IllegalArgumentException("Unknown maintenance action");
            };
            System.out.println(json.writeValueAsString(result));
        }
    }

    static ResidentWorkspaceRetirementStore.Request readRequest(Path path, ObjectMapper json) throws Exception {
        try (var input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = input.readNBytes(16 * 1024 + 1);
            if (bytes.length > 16 * 1024) {
                throw new IllegalArgumentException("Maintenance request exceeds its size limit");
            }
            var request = json.readValue(bytes, ResidentWorkspaceRetirementStore.Request.class);
            if (request == null) {
                throw new IllegalArgumentException("Maintenance request is required");
            }
            return request;
        }
    }
}
