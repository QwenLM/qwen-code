package com.alibaba.qwen.code.managedagent.persistence;

import com.sun.source.tree.LiteralTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.annotation.Transactional;

import javax.tools.ToolProvider;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** Inventory only: executed branches are checked by StoreLockTrace and MySQL scenarios. */
class SessionRowLockOrderTest {
    private static final Path RESOURCES = Path.of("src/test/resources/lock-contract");
    private static final Path PRODUCTION = Path.of("../persistence/src/main/java");
    private static final Set<String> CATEGORIES = Set.of("query", "creation", "session", "cas", "journal", "lifecycle");

    @Test
    void allEntriesHaveExactSignaturesTransactionAttributesAndScenarios() throws Exception {
        for (var facade : List.of(ManagedAgentStore.class, JdbcManagedSessionStore.class)) {
            assertThat(facade.getAnnotation(org.springframework.beans.factory.annotation.Qualifier.class).value())
                    .isEqualTo("managedAgentTransactionManager");
        }
        var types = new TreeSet<Class<?>>(java.util.Comparator.comparing(Class::getName));
        for (Class<?> facade : List.of(ManagedAgentStore.class, JdbcManagedSessionStore.class,
                JdbcManagedActionStore.class, JdbcManagedUserMessageStore.class, WorkspaceRecoveryStore.class)) {
            collect(facade, types);
        }
        var actual = new TreeSet<String>();
        for (var type : types) {
            for (Method method : type.getDeclaredMethods()) {
                if (Modifier.isPrivate(method.getModifiers()) || method.isSynthetic()
                        || type.isInterface() && !method.isDefault()) {
                    continue;
                }
                String signature = type.getName() + "#" + method.getName() + "("
                        + Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).collect(Collectors.joining(",")) + ")";
                var annotation = method.getAnnotation(Transactional.class);
                var tx = new AnnotationTransactionAttributeSource(false).getTransactionAttribute(method, type);
                actual.add(signature + "|" + (annotation == null ? "inherited" : attributes(annotation))
                        + "|" + (tx == null ? "none" : tx.toString()));
            }
        }
        var expected = new TreeSet<String>();
        for (String line : Files.readAllLines(RESOURCES.resolve("entries.txt"))) {
            var columns = line.split("\\|", 3);
            assertThat(CATEGORIES).contains(columns[0]);
            try (var sources = Files.walk(Path.of("src/test/java"))) {
                assertThat(sources.anyMatch(path -> path.getFileName().toString().equals(columns[1] + ".java")))
                        .as("scenario suite for %s", line).isTrue();
            }
            assertThat(expected.add(columns[2])).as("entry registered once: %s", line).isTrue();
        }
        assertThat(actual).containsExactlyElementsOf(expected);
    }

    @Test
    void protectedSqlOwnersAndLiteralSpellingsStayExplicit() throws Exception {
        var compiler = ToolProvider.getSystemJavaCompiler();
        var actual = new TreeSet<String>();
        try (var manager = compiler.getStandardFileManager(null, null, null);
                var paths = Files.walk(PRODUCTION)) {
            var files = paths.filter(path -> path.toString().endsWith(".java")).map(Path::toFile).toList();
            var task = (JavacTask) compiler.getTask(null, manager, null, List.of("-proc:none"), null,
                    manager.getJavaFileObjectsFromFiles(files));
            for (var unit : task.parse()) {
                new TreeScanner<Void, Void>() {
                    @Override
                    public Void visitLiteral(LiteralTree tree, Void unused) {
                        if (tree.getValue() instanceof String value
                                && value.toLowerCase(java.util.Locale.ROOT).matches("(?s).*\\bma_(session|turn|session_head|event_stream)\\b.*")) {
                            actual.add(PRODUCTION.toAbsolutePath().normalize().relativize(Path.of(unit.getSourceFile().toUri())).toString().replace('\\', '/') + "|" + value.replaceAll("\\s+", " ").trim());
                        }
                        return null;
                    }
                }.scan(unit, null);
            }
        }
        assertThat(actual).containsExactlyElementsOf(Files.readAllLines(RESOURCES.resolve("sql-owners.txt")));
    }

    private static String attributes(Transactional tx) {
        return tx.value() + ":" + tx.transactionManager() + ":" + tx.propagation() + ":" + tx.isolation()
                + ":" + tx.timeout() + ":" + tx.timeoutString() + ":" + tx.readOnly()
                + ":" + Arrays.toString(tx.rollbackFor()) + ":" + Arrays.toString(tx.noRollbackFor())
                + ":" + Arrays.toString(tx.rollbackForClassName()) + ":" + Arrays.toString(tx.noRollbackForClassName())
                + ":" + Arrays.toString(tx.label());
    }

    private static void collect(Class<?> type, Set<Class<?>> types) {
        if (types.add(type)) {
            for (var contract : type.getInterfaces()) {
                collect(contract, types);
            }
        }
    }
}
