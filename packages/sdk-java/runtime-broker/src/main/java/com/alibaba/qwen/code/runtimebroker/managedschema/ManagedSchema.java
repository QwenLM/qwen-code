package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;

import java.util.regex.Pattern;

import javax.sql.DataSource;

/** Explicit initializer for the fresh canonical database, independent of legacy bootstrap. */
public final class ManagedSchema {
    public static final String FLYWAY_LOCATION = "classpath:db/managed-schema";
    public static final String RESOURCE = "/db/managed-schema/V1__managed_schema.sql";
    public static final String PRIVATE_AUTHORITY =
            "/db/managed-schema/V2__private_csi_authority.sql";
    public static final String K2_RETIREMENT =
            "/db/managed-schema/V3__k2_retirement_evidence.sql";

    private ManagedSchema() {}

    public static void requireApplicationCatalog(Connection connection) throws SQLException {
        ManagedSchemaCatalog.requireApplicationCatalog(connection);
    }

    public static void initialize(DataSource source) {
        Objects.requireNonNull(source, "source");
        String ddl = ddl();
        try (Connection connection = source.getConnection()) {
            var tables = ManagedSchemaCatalog.tables(connection);
            if (!tables.isEmpty()) {
                int version = schemaVersion(connection);
                if (version < 3) {
                    if (ManagedSchemaCatalog.hasHistory(connection)) {
                        throw new SQLException(
                                "The canonical catalog requires the application's pending migrations");
                    }
                    if (version == 1) {
                        execute(connection, read(PRIVATE_AUTHORITY));
                    }
                    execute(connection, read(K2_RETIREMENT));
                    ManagedSchemaCatalog.validate(connection, ddl);
                }
                return;
            }
            if (ManagedSchemaCatalog.hasHistory(connection)) {
                throw new SQLException("A history-only catalog is not a fresh Managed database");
            }
            execute(connection, ddl);
            ManagedSchemaCatalog.validate(connection, ddl);
        } catch (SQLException exception) {
            throw new IllegalStateException(
                    "Fresh Managed schema initialization failed", exception);
        }
    }

    public static void validate(DataSource source) {
        Objects.requireNonNull(source, "source");
        try (Connection connection = source.getConnection()) {
            ManagedSchemaCatalog.validate(connection, ddl());
        } catch (SQLException exception) {
            throw new IllegalStateException("Managed schema validation failed", exception);
        }
    }

    public static void validate(Connection connection) throws SQLException {
        ManagedSchemaCatalog.validate(Objects.requireNonNull(connection, "connection"), ddl());
    }

    public static String ddl() {
        return extend(extend(read(RESOURCE), read(PRIVATE_AUTHORITY)), read(K2_RETIREMENT));
    }

    private static String extend(String ddl, String extension) {
        for (String raw : extension.replaceAll("(?m)^--[^\\n]*", "").split(";")) {
            String command = raw.trim();
            if (command.isEmpty()) {
                continue;
            }
            var addition = Pattern.compile("ALTER TABLE (ma_[a-z_]+) ADD (?:COLUMN )?(.+)",
                    Pattern.DOTALL).matcher(command);
            if (!addition.matches()) {
                if (!command.startsWith("CREATE TABLE ma_") && !command.startsWith("CREATE INDEX ")
                        && !command.startsWith("CREATE UNIQUE INDEX ")) {
                    throw new IllegalStateException("Unsupported canonical schema extension");
                }
                ddl += "\n" + command + ";\n";
                continue;
            }
            var table =
                    Pattern.compile(
                                    "(CREATE TABLE " + addition.group(1) + " \\()(.*?)(\\) ENGINE=)",
                                    Pattern.DOTALL)
                            .matcher(ddl);
            if (!table.find()) {
                throw new IllegalStateException(
                        "Private authority table is absent from the canonical baseline");
            }
            ddl =
                    table.replaceFirst(
                            java.util.regex.Matcher.quoteReplacement(
                                    table.group(1)
                                            + table.group(2).stripTrailing()
                                            + ",\n    "
                                            + addition.group(2)
                                            + "\n"
                                            + table.group(3)));
        }
        return ddl;
    }

    public static int schemaVersion(DataSource source) {
        try (Connection connection = source.getConnection()) {
            return schemaVersion(connection);
        } catch (SQLException exception) {
            throw new IllegalStateException("Managed schema validation failed", exception);
        }
    }

    private static int schemaVersion(Connection connection) throws SQLException {
        try {
            ManagedSchemaCatalog.validate(connection, ddl());
            return 3;
        } catch (SQLException current) {
            try {
                ManagedSchemaCatalog.validateBaseline(connection,
                        extend(read(RESOURCE), read(PRIVATE_AUTHORITY)));
                return 2;
            } catch (SQLException authority) {
                current.addSuppressed(authority);
            }
            try {
                ManagedSchemaCatalog.validateBaseline(connection, read(RESOURCE));
                return 1;
            } catch (SQLException baseline) {
                current.addSuppressed(baseline);
                throw current;
            }
        }
    }

    private static void execute(Connection connection, String ddl) throws SQLException {
        try (var statement = connection.createStatement()) {
            for (String command : ddl.replaceAll("(?m)^--[^\\n]*", "").split(";")) {
                if (!command.isBlank()) {
                    statement.execute(command.trim());
                }
            }
        }
    }

    private static String read(String resource) {
        try (var stream = ManagedSchema.class.getResourceAsStream(resource)) {
            if (stream == null) {
                throw new IllegalStateException("Canonical Managed schema resource is missing");
            }
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Canonical Managed schema resource cannot be read", exception);
        }
    }
}
