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
    public static final String WORKSPACE_CREATION = "/db/managed-schema/V4__workspace_creation.sql";
    public static final String MODEL_SELECTION = "/db/managed-schema/V5__session_model_selection.sql";
    public static final String APPROVAL_SELECTION = "/db/managed-schema/V6__session_approval_selection.sql";
    public static final String RUNTIME_SESSION_HARNESS = "/db/managed-schema/V9__runtime_session_harness.sql";
    public static final String PLAN_MODE = "/db/managed-schema/V10__session_plan_mode.sql";
    public static final String CSI_APPLICATION_RETIREMENT =
            "/db/managed-schema/V12__csi_application_retirement.sql";
    public static final String WAKE_RECOVERY = "/db/managed-schema/V11__wake_recovery.sql";
    // Additive migrations over the published V1 baseline, in version order.
    public static final String SSH_WORKSPACE =
            "/db/managed-schema/V7__ssh_workspace_registration.sql";
    public static final String TURN_COMMAND_OPERATIONS =
            "/db/managed-schema/V8__turn_command_operations.sql";
    private static final List<Migration> EXTENSIONS = List.of(new Migration(2, PRIVATE_AUTHORITY),
            new Migration(3, SESSION_LIST), new Migration(4, WORKSPACE_CREATION),
            new Migration(5, MODEL_SELECTION), new Migration(6, APPROVAL_SELECTION),
            new Migration(7, SSH_WORKSPACE), new Migration(8, TURN_COMMAND_OPERATIONS),
            new Migration(9, RUNTIME_SESSION_HARNESS), new Migration(10, PLAN_MODE),
            new Migration(11, WAKE_RECOVERY), new Migration(12, CSI_APPLICATION_RETIREMENT));
    private static final int CURRENT = EXTENSIONS.getLast().version();

    private record Migration(int version, String resource) {
    }

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
                                        + EXTENSIONS.stream().filter(extension -> extension.version() > version)
                                                .findFirst().orElseThrow().version()
                                        + " migration");
                    }
                    for (Migration extension : EXTENSIONS) {
                        if (extension.version() > version) {
                            execute(connection, read(extension.resource()));
                        }
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

    public static void validate(Connection connection) throws SQLException {
        ManagedSchemaCatalog.validate(Objects.requireNonNull(connection, "connection"), ddl());
    }

    public static String ddl() {
        return ddl(CURRENT);
    }

    private static String ddl(int version) {
        String ddl = read(RESOURCE);
        for (Migration extension : EXTENSIONS) {
            if (extension.version() <= version) {
                ddl = extend(ddl, read(extension.resource()));
            }
        }
        return ddl;
    }

    private static String extend(String ddl, String extension) {
        var checks = Pattern.compile("ALTER TABLE (ma_[a-z_]+) DROP CONSTRAINT ([a-z_]+);\\s*"
                + "ALTER TABLE \\1 ADD CONSTRAINT \\2 CHECK ([^;]+);").matcher(extension);
        while (checks.find()) {
            String name = checks.group(2);
            var original = Pattern.compile("(?m)CONSTRAINT " + name + " CHECK [^\\n]+").matcher(ddl);
            if (!original.find()) {
                throw new IllegalStateException("Changed check is absent from the canonical baseline");
            }
            ddl = original.replaceFirst(java.util.regex.Matcher.quoteReplacement(
                    "CONSTRAINT " + name + " CHECK " + checks.group(3)
                            + (original.group().endsWith(",") ? "," : "")));
        }
        extension = checks.replaceAll("");
        var columns =
                Pattern.compile("ALTER TABLE (ma_[a-z_]+) ADD (?:COLUMN )?([^;]+);").matcher(extension);
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
        for (int index = EXTENSIONS.size(); index >= 0; index--) {
            int version = index == 0 ? 1 : EXTENSIONS.get(index - 1).version();
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
