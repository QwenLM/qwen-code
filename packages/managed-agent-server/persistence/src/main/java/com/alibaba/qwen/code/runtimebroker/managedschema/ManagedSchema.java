package com.alibaba.qwen.code.runtimebroker.managedschema;

import javax.sql.DataSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;

/** Explicit initializer for the fresh Managed database, independent of legacy bootstrap. */
public final class ManagedSchema {
    public static final String FLYWAY_LOCATION = "classpath:db/managed-schema";
    public static final String RESOURCE = "/db/managed-schema/V1__managed_schema.sql";

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
                ManagedSchemaCatalog.validate(connection, ddl);
                return;
            }
            // Only a catalog that holds nothing but Flyway history is refused. An
            // application database that also carries business objects is the shared
            // catalog this initializer now supports, and its history stays untouched.
            if (ManagedSchemaCatalog.hasHistory(connection)
                    && ManagedSchemaCatalog.hasOnlyHistory(connection)) {
                throw new SQLException("A history-only catalog is not a fresh Managed database");
            }
            execute(connection, ddl);
            ManagedSchemaCatalog.validate(connection, ddl);
        } catch (SQLException exception) {
            throw new IllegalStateException(
                    "Fresh Managed schema initialization failed", exception);
        }
    }

    /**
     * True when the catalog already holds Managed namespace tables. The Flyway
     * strategy and the preflight use it to tell "this chain has applied its
     * baseline" apart from "the catalog's history belongs to the host".
     */
    public static boolean hasManagedTables(Connection connection) throws SQLException {
        return !ManagedSchemaCatalog.tables(connection).isEmpty();
    }

    /** Data-source form of {@link #hasManagedTables(Connection)}. */
    public static boolean hasManagedTables(DataSource source) {
        try (Connection connection = source.getConnection()) {
            return hasManagedTables(connection);
        } catch (SQLException exception) {
            return false;
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
        return read(RESOURCE);
    }

    public static int schemaVersion(DataSource source) {
        validate(source);
        // Keep V1 until the first formal release; update the shared baseline in place.
        return 1;
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
