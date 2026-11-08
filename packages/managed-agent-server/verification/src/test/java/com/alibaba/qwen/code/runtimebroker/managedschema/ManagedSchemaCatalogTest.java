package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedSchemaCatalogTest {

    @Test
    void requiresStrictGlobalAndSessionSqlModes() throws Exception {
        for (String product : new String[] {"MySQL", "MariaDB"}) {
            try (var data = fixture(false)) {
                ManagedSchemaCatalog.requireApplicationCatalog(adapted(data, product, "8.4.11", 1, 1,
                        "NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"));
                ManagedSchemaCatalog.requireApplicationCatalog(adapted(data, product, "8.4.11", 1, 1,
                        "STRICT_ALL_TABLES", "NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES"));
                for (String[] modes : new String[][] {
                        {"", "STRICT_TRANS_TABLES"},
                        {"STRICT_ALL_TABLES", ""},
                        {"NO_STRICT_TRANS_TABLES", "STRICT_TRANS_TABLES"},
                        {"STRICT_ALL_TABLES", "STRICT_ALL_TABLES_DISABLED"}}) {
                    var connection = adapted(data, product, "8.4.11", 1, 1, modes[0], modes[1]);
                    var error = assertThrows(SQLException.class,
                            () -> ManagedSchemaCatalog.requireApplicationCatalog(connection));
                    assertTrue(error.getMessage().contains("requires strict SQL mode"));
                }
            }
        }
    }

    @Test
    void acceptsMariaDbMetadataWithoutRequiringDatabaseChecks() throws Exception {
        for (String product : new String[] {"MySQL", "MariaDB"}) {
            try (var data = fixture(false); var statement = data.createStatement()) {
                statement.execute("DELETE FROM catalog_fixture.table_constraints");
                Connection connection = mariaDb(data, product, 1, 1);
                ManagedSchemaCatalog.requireApplicationCatalog(connection);
                ManagedSchemaCatalog.validateChecks(connection, "ma_operation");
            }
        }
    }

    @Test
    void rejectsUnexpectedDatabaseChecksRegardlessOfTheirExpression() throws Exception {
        for (String product : new String[] {"MySQL", "MariaDB"}) {
            try (var data = fixture(false); var update = data.prepareStatement(
                    "UPDATE catalog_fixture.check_constraints SET check_clause=?")) {
                Connection connection = mariaDb(data, product, 1, 1);
                for (String expression : new String[] {"state = 'OK'", "state <> 'OK'", "1 = 1"}) {
                    update.setString(1, expression);
                    update.executeUpdate();
                    assertThrows(SQLException.class,
                            () -> ManagedSchemaCatalog.validateChecks(connection, "ma_operation"));
                }
            }
        }
    }

    @Test
    void acceptsNumericGeneratedBooleansWithoutAcceptingExpressionDrift() throws Exception {
        String body = "\n    is_csi_guard BOOLEAN GENERATED ALWAYS AS (COALESCE("
                + "tool_profile = 'csi-files-retirement/1' OR runtime_request_key IS NOT NULL, FALSE))\n";
        String numeric = "coalesce(`tool_profile` = 'csi-files-retirement/1'"
                + " or `runtime_request_key` is not null,0)";
        try (var data = fixture(false); var update = data.prepareStatement(
                "UPDATE catalog_fixture.columns SET generation_expression=?")) {
            Connection connection = mariaDb(data, "MySQL", 1, 1);
            update.setString(1, numeric);
            update.executeUpdate();
            ManagedSchemaCatalog.validateGeneratedColumns(connection, "ma_session", body);
            for (String changed : new String[] {
                    numeric.replace(",0)", ",1)"),
                    numeric.replace(",0)", ",'FALSE')"),
                    numeric.replace(" = ", " <> ")}) {
                update.setString(1, changed);
                update.executeUpdate();
                assertThrows(SQLException.class,
                        () -> ManagedSchemaCatalog.validateGeneratedColumns(connection, "ma_session", body),
                        changed);
            }
        }
    }

    @Test
    void rejectsNonTransactionalTablesWithEitherMariaDbDriverProductName() throws Exception {
        for (String product : new String[] {"MySQL", "MariaDB"}) {
            try (var data = fixture(false); var statement = data.createStatement()) {
                for (String table : ManagedSchemaContract.TABLES) {
                    statement.execute("CREATE TABLE " + table + " (witness INT)");
                }
                Connection connection = mariaDb(data, product, 1, 1);
                SQLException error = assertThrows(SQLException.class,
                        () -> ManagedSchemaCatalog.validate(connection, ManagedSchema.ddl()));
                assertTrue(error.getMessage().contains("requires InnoDB: MA_TENANT_GUARD"),
                        error.getMessage());
            }
        }
    }

    @Test
    void rejectsDisabledMariaDbGlobalOrSessionChecks() throws Exception {
        for (int[] settings : new int[][] {{0, 1}, {1, 0}}) {
            try (var data = fixture(false)) {
                Connection connection = mariaDb(data, "MySQL", settings[0], settings[1]);
                assertThrows(SQLException.class,
                        () -> ManagedSchemaCatalog.requireApplicationCatalog(connection));
            }
        }
    }

    @Test
    void rejectsUnexpectedMySqlChecksEvenWhenTheyAreNotEnforced() throws Exception {
        try (var data = fixture(true); var statement = data.createStatement()) {
            assertThrows(SQLException.class,
                    () -> ManagedSchemaCatalog.validateChecks(data, "ma_operation"));
            statement.execute("UPDATE catalog_fixture.table_constraints SET enforced='NO'");
            assertThrows(SQLException.class,
                    () -> ManagedSchemaCatalog.validateChecks(data, "ma_operation"));
        }
    }

    private static Connection fixture(boolean enforcedColumn) throws SQLException {
        Connection data = DriverManager.getConnection("jdbc:h2:mem:catalog-" + UUID.randomUUID());
        try (var statement = data.createStatement()) {
            statement.execute("CREATE SCHEMA catalog_fixture");
            statement.execute("CREATE TABLE catalog_fixture.columns"
                    + " (column_name VARCHAR, generation_expression VARCHAR, table_schema VARCHAR, table_name VARCHAR)");
            statement.execute("INSERT INTO catalog_fixture.columns"
                    + " VALUES ('is_csi_guard',NULL,'PUBLIC','MA_SESSION')");
            statement.execute("CREATE TABLE catalog_fixture.table_constraints"
                    + " (constraint_name VARCHAR, constraint_schema VARCHAR, table_schema VARCHAR,"
                    + " table_name VARCHAR, constraint_type VARCHAR"
                    + (enforcedColumn ? ", enforced VARCHAR DEFAULT 'YES'" : "") + ")");
            statement.execute("CREATE TABLE catalog_fixture.check_constraints"
                    + " (constraint_name VARCHAR, constraint_schema VARCHAR, check_clause VARCHAR)");
            statement.execute("INSERT INTO catalog_fixture.table_constraints"
                    + " VALUES ('ck_probe','PUBLIC','PUBLIC','MA_OPERATION','CHECK'"
                    + (enforcedColumn ? ",'YES'" : "") + ")");
            statement.execute("INSERT INTO catalog_fixture.check_constraints"
                    + " VALUES ('ck_probe','PUBLIC','(state = ''OK'')')");
        }
        return adapted(data, "MySQL", "8.4.11", 1, 1, "STRICT_TRANS_TABLES", "STRICT_TRANS_TABLES");
    }

    private static Connection mariaDb(Connection data, String product, int global, int session) {
        return adapted(data, product, "10.11.18-MariaDB", global, session,
                "STRICT_TRANS_TABLES", "STRICT_TRANS_TABLES");
    }

    private static Connection adapted(Connection data, String product, String version,
            int global, int session, String globalMode, String sessionMode) {
        DatabaseMetaData metadata = (DatabaseMetaData) Proxy.newProxyInstance(
                ManagedSchemaCatalogTest.class.getClassLoader(), new Class<?>[] {DatabaseMetaData.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getDatabaseProductName" -> product;
                    case "getDatabaseProductVersion" -> version;
                    default -> invoke(method, data.getMetaData(), args);
                });
        return (Connection) Proxy.newProxyInstance(ManagedSchemaCatalogTest.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, args) -> {
                    if ("getMetaData".equals(method.getName())) {
                        return metadata;
                    }
                    if ("prepareStatement".equals(method.getName())) {
                        String sql = (String) args[0];
                        if (sql.contains("@@GLOBAL.sql_mode")) {
                            args[0] = "SELECT '" + globalMode + "', '" + sessionMode + "'";
                        } else {
                            args[0] = sql.contains("@@GLOBAL.check_constraint_checks")
                                    ? "SELECT " + global + ", " + session
                                    : sql.startsWith("SELECT TABLE_NAME, ENGINE")
                                            ? "SELECT TABLE_NAME, CASE WHEN TABLE_NAME='MA_TENANT_GUARD'"
                                                    + " THEN 'MyISAM' ELSE 'InnoDB' END AS ENGINE FROM"
                                                    + " INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?"
                                            : sql.replace("INFORMATION_SCHEMA.TABLE_CONSTRAINTS", "catalog_fixture.table_constraints")
                                            .replace("INFORMATION_SCHEMA.CHECK_CONSTRAINTS", "catalog_fixture.check_constraints")
                                            .replace("INFORMATION_SCHEMA.COLUMNS", "catalog_fixture.columns");
                        }
                    }
                    return invoke(method, data, args);
                });
    }

    private static Object invoke(java.lang.reflect.Method method, Object target, Object[] args)
            throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
