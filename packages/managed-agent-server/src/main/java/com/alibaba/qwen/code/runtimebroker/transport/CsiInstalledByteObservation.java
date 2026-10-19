package com.alibaba.qwen.code.runtimebroker.transport;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/** Closed recorded bytes, never an installation or release capability. */
public record CsiInstalledByteObservation(String format, String role, String installationSha256,
        String architecture, String packedSha256, int packedBytes, String configurationPath,
        String configurationSha256, String shimConfigurationSha256, String unitPath, String unitSha256) {
    public CsiInstalledByteObservation {
        require("qwen-k2-installed-byte-observation/1".equals(format)
                && role != null && List.of("source", "gateway").contains(role)
                && hash(installationSha256) && architecture != null && List.of("amd64", "arm64").contains(architecture)
                && hash(packedSha256) && packedBytes > 0 && packedBytes <= 8 * 1024 * 1024
                && configurationPath != null && configurationPath.length() <= 2048
                && configurationPath.matches("/etc/qwen-k2/[A-Za-z0-9_.-]+\\.json")
                && hash(configurationSha256) && hash(shimConfigurationSha256) && hash(unitSha256)
                && ("/etc/systemd/system/" + ("source".equals(role)
                        ? "qwen-k2-node-source.service" : "qwen-k2-runtime-gateway.service")).equals(unitPath));
    }

    public static void requirePair(CsiInstalledByteObservation source, CsiInstalledByteObservation gateway) {
        require(source != null && gateway != null && "source".equals(source.role()) && "gateway".equals(gateway.role())
                && source.installationSha256().equals(gateway.installationSha256())
                && source.architecture().equals(gateway.architecture()) && source.packedSha256().equals(gateway.packedSha256())
                && source.packedBytes() == gateway.packedBytes()
                && source.shimConfigurationSha256().equals(gateway.shimConfigurationSha256())
                && !source.configurationPath().equals(gateway.configurationPath()));
    }

    static CsiInstalledByteObservation read(JsonNode value) {
        CsiNodeSourceJournal.fields(value, List.of("format", "role", "installationSha256", "architecture", "packedSha256",
                "packedBytes", "configurationPath", "configurationSha256", "shimConfigurationSha256", "unitPath", "unitSha256"));
        return new CsiInstalledByteObservation(text(value, "format"), text(value, "role"), text(value, "installationSha256"),
                text(value, "architecture"), text(value, "packedSha256"),
                Math.toIntExact(CsiNodeSourceJournal.integer(value, "packedBytes", 8 * 1024 * 1024)),
                text(value, "configurationPath"), text(value, "configurationSha256"), text(value, "shimConfigurationSha256"),
                text(value, "unitPath"), text(value, "unitSha256"));
    }

    private static String text(JsonNode value, String name) {
        return CsiNodeSourceJournal.text(value, name);
    }

    private static boolean hash(String value) {
        return value != null && value.matches("[0-9a-f]{64}");
    }

    private static void require(boolean value) {
        if (!value) {
            throw new IllegalArgumentException("Invalid CSI installed byte observation");
        }
    }
}
