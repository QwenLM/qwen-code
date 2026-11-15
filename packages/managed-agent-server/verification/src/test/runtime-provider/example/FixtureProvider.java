package example;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;

import java.net.URI;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

public final class FixtureProvider implements RuntimeProviderFactory {
    public static int created;
    public static int closed;
    public static String endpoint;

    @Override
    public Set<String> kinds() {
        return Set.of("fixture-http");
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        if (!settings.getRuntimeBroker().getProviderOptions().containsKey("endpoint")) {
            throw new IllegalStateException("Fixture endpoint is required");
        }
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        return List.of(new Check("fixture-diagnostic", Status.WARN, "fixture check was executed", "fixture remedy"));
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        endpoint = settings.getRuntimeBroker().getProviderOptions().get("endpoint");
        created++;
        return new RuntimeProvisioner() {
            @Override
            public String kind() {
                return "fixture-http";
            }

            @Override
            public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
                return CompletableFuture.completedFuture(new RuntimeLease("fixture-runtime", URI.create(endpoint),
                        "fixture-token", "fixture-lease", 1));
            }

            @Override
            public void close() {
                closed++;
            }
        };
    }
}
