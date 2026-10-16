package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Objects;

import java.util.regex.Pattern;

import javax.sql.DataSource;

/** Explicit initializer for the fresh 32-table database, independent of legacy bootstrap. */
public final class ManagedSchema {
    public static final String FLYWAY_LOCATION = "classpath:db/managed-schema";
    public static final String RESOURCE = "/db/managed-schema/V1__managed_schema.sql";
    public static final String PRIVATE_AUTHORITY =
            "/db/managed-schema/V2__private_csi_authority.sql";
    public static final String SESSION_LIST =
            "/db/managed-schema/V3__session_list_created_at.sql";
    // Additive migrations over the published V1 baseline, in version order.
    private static final List<String> EXTENSIONS = List.of(PRIVATE_AUTHORITY, SESSION_LIST);
    private static final int CURRENT = EXTENSIONS.size() + 1;

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
                if (version < CURRENT) {
                    if (ManagedSchemaCatalog.hasHistory(connection)) {
                        throw new SQLException(
                                "The canonical V"
                                        + version
                                        + " catalog requires the application's V"
                                        + (version + 1)
                                        + " migration");
                    }
                    for (String extension : EXTENSIONS.subList(version - 1, EXTENSIONS.size())) {
                        execute(connection, read(extension));
                    }
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

    public static String ddl() {
        return ddl(CURRENT);
    }

    private static String ddl(int version) {
        String ddl = read(RESOURCE);
        for (String extension : EXTENSIONS.subList(0, version - 1)) {
            ddl = extend(ddl, read(extension));
        }
        return ddl;
    }

    private static String extend(String ddl, String extension) {
        var columns =
                Pattern.compile("ALTER TABLE (ma_[a-z_]+) ADD COLUMN ([^;]+);").matcher(extension);
        while (columns.find()) {
            var table =
                    Pattern.compile(
                                    "(CREATE TABLE " + columns.group(1) + " \\()(.*?)(\\) ENGINE=)",
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
                                            + columns.group(2)
                                            + "\n"
                                            + table.group(3)));
        }
        var drops = Pattern.compile("DROP INDEX ([a-z_]+) ON (ma_[a-z_]+);").matcher(extension);
        while (drops.find()) {
            var index =
                    Pattern.compile(
                                    "\\nCREATE INDEX "
                                            + drops.group(1)
                                            + " ON "
                                            + drops.group(2)
                                            + " \\([^)]+\\);")
                            .matcher(ddl);
            if (!index.find()) {
                throw new IllegalStateException(
                        "Dropped index is absent from the canonical baseline");
            }
            ddl = index.replaceFirst("");
        }
        var indexes = Pattern.compile("CREATE INDEX [^;]+;").matcher(extension);
        while (indexes.find()) {
            ddl += "\n" + indexes.group();
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
        SQLException current = null;
        for (int version = CURRENT; version >= 1; version--) {
            try {
                ManagedSchemaCatalog.validate(connection, ddl(version));
                return version;
            } catch (SQLException mismatch) {
                if (current == null) {
                    current = mismatch;
                } else {
                    current.addSuppressed(mismatch);
                }
            }
        }
        throw current;
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
