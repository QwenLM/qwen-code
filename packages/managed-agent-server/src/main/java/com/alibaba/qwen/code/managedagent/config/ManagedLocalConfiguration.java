package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

@Configuration
@Profile("managed-local")
public class ManagedLocalConfiguration {
    @Bean(name = "managedAgentDataSource", destroyMethod = "close")
    DruidDataSource managedLocalDataSource(DataSourceProperties source,
            ServerProperties server, ManagedAgentProperties properties,
            Environment environment) throws IOException {
        Path directory = Path.of(environment.getRequiredProperty(
                "QWEN_MANAGED_AGENT_LOCAL_DATA_DIRECTORY"));
        requirePrivateDirectory(directory);
        if (directory.toString().contains(";")) {
            throw new IllegalStateException("Managed local data directory cannot contain ';'");
        }
        if (!jdbcUrl(directory).equals(source.getUrl())) {
            throw new IllegalStateException("Managed local requires its private file H2 database");
        }
        if (environment.getProperty("spring.h2.console.enabled", Boolean.class, false)) {
            throw new IllegalStateException("Managed local does not expose an H2 Web console");
        }
        if (server.getAddress() == null || !server.getAddress().isLoopbackAddress()
                || !BrokerSecurity.isLoopback(properties.getInternalServer().getAddress())
                || !BrokerSecurity.isLoopback(properties.getRuntimeBroker().getHost())) {
            throw new IllegalStateException("Managed local listeners must use loopback addresses");
        }
        requireLoopbackUrl(properties.getHarness().getBaseUrl());
        requireLoopbackUrl(properties.getSessionStore().getBaseUrl());
        var broker = properties.getRuntimeBroker();
        if (!"signed".equals(properties.getAuth().getMode())
                || !"local-process".equals(broker.getProvisioner())
                || !broker.isDurableLocalProcess() || !broker.isVerifiedWorkspaceRecoveryEnabled()
                || broker.getSsh().isEnabled() || !broker.getSsh().getNodes().isEmpty()
                || !broker.getWorkspaceMounts().isEmpty() || !broker.getResidentWorkspaces().isEmpty()
                || !directory.resolve("runtime").toString().equals(broker.getStateDirectory())
                || !directory.resolve("legacy").toString().equals(broker.getWorkspaceCwd())
                || !directory.resolve("workspaces").toString().equals(broker.getWorkspaceCreationRoot())) {
            throw new IllegalStateException("Managed local requires signed authentication and private local Workspaces");
        }
        for (String name : new String[] {"database", "runtime", "workspaces", "legacy"}) {
            Path child = directory.resolve(name);
            if (!Files.exists(child, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(child, PosixFilePermissions.asFileAttribute(
                        PosixFilePermissions.fromString("rwx------")));
            }
            requirePrivateDirectory(child);
        }
        try (var files = Files.list(directory.resolve("database"))) {
            if (files.anyMatch(Files::isSymbolicLink)) {
                throw new IllegalStateException("Managed local database files cannot be symbolic links");
            }
        }
        DruidDataSource dataSource = new DruidDataSource();
        dataSource.setDriverClassName("org.h2.Driver");
        dataSource.setUrl(source.getUrl());
        dataSource.setUsername(source.getUsername());
        dataSource.setPassword(source.getPassword());
        dataSource.setInitialSize(1);
        dataSource.setMinIdle(1);
        dataSource.setMaxActive(20);
        dataSource.setMaxWait(30_000);
        dataSource.setKeepAlive(true);
        dataSource.setValidationQuery("SELECT 1");
        return dataSource;
    }

    static String jdbcUrl(Path directory) {
        return "jdbc:h2:file:" + directory.resolve("database/managed")
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_ON_EXIT=FALSE;WRITE_DELAY=0";
    }

    private static void requirePrivateDirectory(Path directory) throws IOException {
        if (!directory.isAbsolute() || !directory.equals(directory.toRealPath())
                || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)
                || !Files.getOwner(directory).getName().equals(System.getProperty("user.name"))
                || !Files.getPosixFilePermissions(directory).equals(
                        PosixFilePermissions.fromString("rwx------"))) {
            throw new IllegalStateException("Managed local data directories must be canonical owner-only directories");
        }
    }

    private static void requireLoopbackUrl(String value) {
        URI uri = URI.create(value);
        if (!"http".equals(uri.getScheme())
                || uri.getHost() == null
                || !Set.of("127.0.0.1", "localhost", "[::1]").contains(uri.getHost())
                || uri.getPort() < 1 || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null
                || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
            throw new IllegalStateException("Managed local service URLs must use loopback HTTP endpoints");
        }
    }
}
