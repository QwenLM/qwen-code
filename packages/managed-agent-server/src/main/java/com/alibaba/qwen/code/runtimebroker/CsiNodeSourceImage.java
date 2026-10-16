package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.fields;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.integer;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.object;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.require;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.text;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;

/** Original OCI content and snapshot associations, not deployment authority. */
final class CsiNodeSourceImage {
    private static final int LIMIT = 64 * 1024;
    private static final String MANIFEST = "application/vnd.oci.image.manifest.v1+json";
    private static final String CONFIG = "application/vnd.oci.image.config.v1+json";
    private static final String LAYER = "application/vnd.oci.image.layer.v1.tar";

    private CsiNodeSourceImage() {}

    static void validate(JsonNode proof) {
        fields(proof, List.of("manifestSha256", "manifest", "configuration", "snapshotter", "snapshots"));
        String image = text(proof, "manifestSha256");
        require(image.matches("[0-9a-f]{64}") && "overlayfs".equals(text(proof, "snapshotter")));
        byte[] manifestRaw = raw(proof, "manifest"), configRaw = raw(proof, "configuration");
        require(manifestRaw.length + configRaw.length <= LIMIT && image.equals(CsiNativeActivationProof.sha256(manifestRaw)));
        JsonNode manifest = object(manifestRaw, LIMIT), config = object(configRaw, LIMIT);
        allowed(manifest, Set.of("schemaVersion", "mediaType", "config", "layers", "annotations", "artifactType", "subject"));
        require(integer(manifest, "schemaVersion", 2) == 2 && MANIFEST.equals(text(manifest, "mediaType"))
                && !manifest.has("subject") && !manifest.has("artifactType"));
        descriptor(manifest.path("config"), Set.of(CONFIG));
        require(text(manifest.path("config"), "digest").equals("sha256:" + CsiNativeActivationProof.sha256(configRaw))
                && integer(manifest.path("config"), "size", LIMIT) == configRaw.length);
        JsonNode layers = manifest.path("layers");
        require(layers.isArray() && !layers.isEmpty() && layers.size() <= 64);
        for (JsonNode layer : layers) {
            descriptor(layer, Set.of(LAYER, LAYER + "+gzip", LAYER + "+zstd"));
        }
        allowed(config, Set.of("created", "author", "architecture", "os", "os.version", "os.features", "variant", "config", "rootfs", "history"));
        require("linux".equals(text(config, "os")) && Set.of("amd64", "arm64").contains(text(config, "architecture")));
        JsonNode rootfs = config.path("rootfs"), snapshots = proof.path("snapshots");
        fields(rootfs, List.of("type", "diff_ids"));
        JsonNode diffIds = rootfs.path("diff_ids");
        require("layers".equals(text(rootfs, "type")) && diffIds.isArray() && diffIds.size() == layers.size()
                && snapshots.isArray() && snapshots.size() == layers.size() + 1);
        var chain = new ArrayList<String>();
        for (JsonNode diff : diffIds) {
            require(diff.isTextual() && diff.textValue().matches("sha256:[0-9a-f]{64}"));
            chain.add(chain.isEmpty() ? diff.textValue() : "sha256:" + CsiNativeActivationProof.sha256(
                    (chain.getLast() + " " + diff.textValue()).getBytes(StandardCharsets.UTF_8)));
        }
        for (int index = 0; index < snapshots.size(); index++) {
            JsonNode snapshot = snapshots.get(index);
            fields(snapshot, List.of("name", "parent", "kind"));
            if (index == 0) {
                String key = text(snapshot, "name");
                require(!key.isEmpty() && key.length() <= 128 && chain.getLast().equals(text(snapshot, "parent"))
                        && integer(snapshot, "kind", 3) == 2);
            } else {
                int original = chain.size() - index;
                require(chain.get(original).equals(text(snapshot, "name"))
                        && (original == 0 ? "" : chain.get(original - 1)).equals(text(snapshot, "parent"))
                        && integer(snapshot, "kind", 3) == 3);
            }
        }
    }

    private static void descriptor(JsonNode value, Set<String> mediaTypes) {
        allowed(value, Set.of("mediaType", "digest", "size", "urls", "annotations", "data", "platform", "artifactType"));
        require(mediaTypes.contains(text(value, "mediaType")) && text(value, "digest").matches("sha256:[0-9a-f]{64}")
                && integer(value, "size", Long.MAX_VALUE) > 0 && !value.has("platform") && !value.has("artifactType")
                && (!value.has("urls") || value.path("urls").isArray() && value.path("urls").isEmpty())
                && (!value.has("data") || value.path("data").isTextual() && value.path("data").textValue().isEmpty()));
        if (value.has("annotations")) {
            annotations(value.path("annotations"));
        }
    }

    private static void allowed(JsonNode value, Set<String> names) {
        require(value.isObject());
        value.fieldNames().forEachRemaining(name -> require(names.contains(name)));
        if (value.has("annotations")) {
            annotations(value.path("annotations"));
        }
    }

    private static void annotations(JsonNode value) {
        require(value.isObject());
        value.elements().forEachRemaining(item -> require(item.isTextual()));
    }

    private static byte[] raw(JsonNode value, String name) {
        String encoded = text(value, name);
        require(encoded.length() <= (LIMIT + 2) / 3 * 4);
        byte[] bytes = Base64.getDecoder().decode(encoded);
        require(bytes.length > 0 && bytes.length <= LIMIT && encoded.equals(Base64.getEncoder().encodeToString(bytes)));
        return bytes;
    }
}
