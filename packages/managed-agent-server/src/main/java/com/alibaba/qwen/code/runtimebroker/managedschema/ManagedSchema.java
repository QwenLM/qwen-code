package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
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
            "/db/managed-schema/V7__k2_retirement_evidence.sql";
    public static final String SESSION_LIST =
            "/db/managed-schema/V3__session_list_created_at.sql";
    public static final String WORKSPACE_CREATION = "/db/managed-schema/V4__workspace_creation.sql";
    public static final String MODEL_SELECTION = "/db/managed-schema/V5__session_model_selection.sql";
    public static final String APPROVAL_SELECTION = "/db/managed-schema/V6__session_approval_selection.sql";
    // Additive migrations over the published V1 baseline, in version order.
    private static final List<String> EXTENSIONS = List.of(PRIVATE_AUTHORITY, SESSION_LIST, WORKSPACE_CREATION, MODEL_SELECTION, APPROVAL_SELECTION, K2_RETIREMENT);
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
                                "The canonical V" + version + " catalog requires the application's V" + (version + 1) + " migration");
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

    public static void validate(Connection connection) throws SQLException {
        ManagedSchemaCatalog.validate(Objects.requireNonNull(connection, "connection"), ddl());
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
        for (String raw : extension.replaceAll("(?m)^--[^\\n]*", "").split(";")) {
            String command = raw.trim();
            if (command.isEmpty()) {
                continue;
            }
            if (command.equals("ALTER TABLE ma_request_receipt DROP CONSTRAINT ck_ma_request_namespace")) {
                var constraint = Pattern.compile("(?m)^    CONSTRAINT ck_ma_request_namespace CHECK[^\\n]+\\n?")
                        .matcher(ddl);
                if (!constraint.find()) {
                    throw new IllegalStateException("Receipt namespace constraint is absent from the baseline");
                }
                ddl = constraint.replaceFirst("");
                continue;
            }
            var drop = Pattern.compile("DROP INDEX ([a-z_]+) ON (ma_[a-z_]+)").matcher(command);
            if (drop.matches()) {
                var index = Pattern.compile("\\nCREATE INDEX " + drop.group(1) + " ON " + drop.group(2)
                        + " \\([^)]+\\);").matcher(ddl);
                if (!index.find()) {
                    throw new IllegalStateException("Dropped index is absent from the canonical baseline");
                }
                ddl = index.replaceFirst("");
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
        SQLException current = null;
        for (int version = CURRENT; version >= 1; version--) {
            try {
                if (version == CURRENT) {
                    ManagedSchemaCatalog.validate(connection, ddl(version));
                } else {
                    ManagedSchemaCatalog.validateBaseline(connection, ddl(version));
                }
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
