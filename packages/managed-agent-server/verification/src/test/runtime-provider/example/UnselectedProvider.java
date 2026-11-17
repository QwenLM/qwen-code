package example;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;

import java.util.List;
import java.util.Set;

public final class UnselectedProvider implements RuntimeProviderFactory {
    @Override
    public Set<String> kinds() {
        return Set.of("unselected");
    }

    @Override
    public void validate(ManagedAgentSettings settings) {
        throw new AssertionError("Unselected configuration was validated");
    }

    @Override
    public List<Check> preflight(ManagedAgentSettings settings) {
        throw new AssertionError("Unselected preflight was executed");
    }

    @Override
    public RuntimeProvisioner create(ManagedAgentSettings settings, RuntimeTransport transport,
            RuntimeProviderDependencies dependencies) {
        throw new AssertionError("Unselected provider was initialized");
    }
}
