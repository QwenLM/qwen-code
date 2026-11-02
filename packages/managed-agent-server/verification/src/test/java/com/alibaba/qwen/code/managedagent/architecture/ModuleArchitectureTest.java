package com.alibaba.qwen.code.managedagent.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class ModuleArchitectureTest {
    @Test
    void compiledModulesRespectTheirBoundariesAndOwnTheirPackages() {
        var modules = new LinkedHashMap<String, JavaClasses>();
        for (String module : List.of("contracts", "control-plane", "runtime-broker", "persistence", "adapters", "server")) {
            var classes = new ClassFileImporter().importPath(Path.of("..", module, "target", "classes"));
            assertThat(classes).as("compiled classes of %s", module).isNotEmpty();
            modules.put(module, classes);
            Path declarations = Path.of("..", module, "target", "classes", "csi-native-file-declarations.json");
            assertThat(Files.exists(declarations)).as("native-tool declarations in %s", module)
                    .isEqualTo(module.equals("contracts"));
        }
        Map<String, String> owners = new HashMap<>();
        Map<String, String> packages = new HashMap<>();
        modules.forEach((module, classes) -> classes.forEach(type -> {
            assertThat(owners.put(type.getName(), module)).as("duplicate class %s", type.getName()).isNull();
            String previous = packages.putIfAbsent(type.getPackageName(), module);
            assertThat(previous == null || previous.equals(module)).as("split package %s: %s / %s", type.getPackageName(), previous, module).isTrue();
        }));
        modules.forEach((module, classes) -> classes.forEach(type -> type.getDirectDependenciesFromSelf().forEach(dependency -> {
            String target = dependency.getTargetClass().getName();
            String owner = owners.get(target);
            Set<String> permitted = module.equals("server") ? modules.keySet() : module.equals("contracts") ? Set.of("contracts") : Set.of(module, "contracts");
            assertThat(owner == null || permitted.contains(owner)).as("%s: %s", module, dependency.getDescription()).isTrue();
            if (!module.equals("server") && !module.equals("adapters")) {
                assertThat(target).doesNotStartWith("com.alibaba.qwen.code.daemon.").doesNotStartWith("com.aliyun.oss.").doesNotStartWith("org.apache.rocketmq.");
            }
            if (module.equals("contracts") || module.equals("runtime-broker")) {
                assertThat(target).doesNotStartWith("org.springframework.");
            }
            if (module.equals("contracts") || module.equals("control-plane") || module.equals("runtime-broker")) {
                assertThat(target).doesNotStartWith("java.sql.").doesNotStartWith("javax.sql.").doesNotStartWith("org.springframework.jdbc.");
            }
            if (module.equals("contracts")) {
                assertThat(target).doesNotStartWith("java.net.http.");
                assertThat(target).isNotEqualTo("java.lang.ProcessBuilder");
            }
            if (module.equals("server")) {
                assertThat(target).doesNotStartWith("com.alibaba.qwen.code.daemon.").doesNotStartWith("com.aliyun.oss.").doesNotStartWith("org.apache.rocketmq.");
            }
        })));
    }
}
