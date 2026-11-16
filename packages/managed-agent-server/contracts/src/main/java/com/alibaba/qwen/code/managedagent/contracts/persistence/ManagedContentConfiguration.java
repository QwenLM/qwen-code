package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/** Immutable content-only configuration and its bounded file-resource closure. */
public final class ManagedContentConfiguration {
    public static final Set<String> ASSET_KINDS = Set.of("managed-extension-assets", "managed-extension-assets-page", "managed-extension-asset-part");
    public static final Set<String> CONTAINERS = Set.of("managed-extension-config-bundle", "managed-extension-contributions",
            "managed-extension-root", "managed-extension-assets", "managed-extension-assets-page");
    private ManagedContentConfiguration() { }

    public static void requireAcknowledgement(JsonNode body, JsonNode configuration) {
        ManagedExtensionRecords.closed(body, Set.of("operationId", "revision", "bundleRef", "side"), "Content acknowledgement");
        require("harness".equals(body.path("side").asText()) && body.path("operationId").equals(configuration.path("command").path("operationId"))
                && body.path("revision").equals(configuration.path("configRevision")) && body.path("bundleRef").equals(configuration.path("bundleRef")),
                "Content acknowledgement conflicts with its Harness configuration");
    }

    public static void requireRoot(JsonNode root, JsonNode header) {
        ManagedExtensionRecords.closed(root, Set.of("formatVersion", "executionMode", "sessionKey", "rootSnapshotRef", "definitionRef"), "Content root");
        require(root.path("formatVersion").isIntegralNumber() && root.path("formatVersion").canConvertToInt() && root.path("formatVersion").asInt() == 2
                && "content-only".equals(root.path("executionMode").asText()), "Invalid content root");
        for (String field : List.of("sessionKey", "rootSnapshotRef", "definitionRef")) {
            require(header != null && header.has(field) && header.get(field).equals(root.get(field)), "Content root conflicts with Session header");
        }
    }

    public static void requireBundle(JsonNode bundle, Function<JsonNode, StoredResource> reader) {
        ManagedExtensionRecords.closed(bundle, Set.of("kind", "formatVersion", "configRevision", "executionMode", "mcpRevision",
                "independentMcpSelections", "baseMcpServers", "baseHookCatalog", "packages", "mcpServers", "hookCatalog"), "Content bundle");
        require("managed-extension-config-bundle".equals(bundle.path("kind").asText()) && bundle.path("formatVersion").isIntegralNumber() && bundle.path("formatVersion").canConvertToInt()
                && bundle.path("formatVersion").asInt() == 2
                && "content-only".equals(bundle.path("executionMode").asText()) && bundle.path("mcpRevision").isIntegralNumber()
                && bundle.path("mcpRevision").asLong(-1) == 0 && bundle.path("baseHookCatalog").isNull() && bundle.path("hookCatalog").isNull(),
                "Invalid content configuration");
        ManagedExtensionRecords.count(bundle.get("configRevision"), 0, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "Content configuration revision");
        for (String field : List.of("independentMcpSelections", "baseMcpServers", "mcpServers")) {
            require(bundle.path(field).isArray() && bundle.path(field).isEmpty(), "Content configuration cannot execute extensions");
        }
        require(bundle.path("packages").isArray() && bundle.path("packages").size() <= 32, "Invalid content packages");
        Set<String> ids = new HashSet<>();
        for (JsonNode entry : bundle.get("packages")) {
            ManagedExtensionRecords.closed(entry, Set.of("pin", "assetRoot", "contributionsRef", "assetsRef"), "Content package");
            JsonNode pin = entry.get("pin");
            ManagedConfigInstall.pins(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode().add(pin));
            require(!pin.has("settingsRevision") && ids.add(pin.path("extensionId").asText())
                    && ("extension://" + pin.path("extensionId").asText() + "/").equals(entry.path("assetRoot").asText()), "Invalid content package pin");
            reference(entry.get("contributionsRef"), "managed-extension-contributions");
            reference(entry.get("assetsRef"), "managed-extension-assets");
            requireAssets(entry.get("assetsRef"), reader);
        }
    }

    public static List<JsonNode> assetReferences(String kind, JsonNode body) {
        List<JsonNode> refs = new ArrayList<>();
        if ("managed-extension-assets".equals(kind)) {
            ManagedExtensionRecords.closed(body, Set.of("kind", "formatVersion", "pages"), "Content assets");
            require(kind.equals(body.path("kind").asText()) && body.path("formatVersion").isIntegralNumber()
                    && body.path("formatVersion").canConvertToInt() && body.path("formatVersion").asInt() == 1
                    && body.path("pages").isArray() && body.path("pages").size() <= 256, "Invalid content assets");
            body.get("pages").forEach(ref -> {
                reference(ref, "managed-extension-assets-page");
                refs.add(ref);
            });
        } else if ("managed-extension-assets-page".equals(kind)) {
            ManagedExtensionRecords.closed(body, Set.of("kind", "formatVersion", "files"), "Content assets page");
            require(kind.equals(body.path("kind").asText()) && body.path("formatVersion").isIntegralNumber()
                    && body.path("formatVersion").canConvertToInt() && body.path("formatVersion").asInt() == 1
                    && body.path("files").isArray() && !body.path("files").isEmpty() && body.path("files").size() <= 256, "Invalid content assets page");
            for (JsonNode file : body.get("files")) {
                ManagedExtensionRecords.closed(file, Set.of("path", "byteLength", "digest", "parts"), "Content asset");
                require(file.path("path").isTextual() && safePath(file.path("path").asText())
                        && file.path("digest").asText().matches("[a-f0-9]{64}") && file.path("parts").isArray()
                        && file.path("parts").size() <= 128, "Invalid content asset");
                ManagedExtensionRecords.count(file.get("byteLength"), 0, 8 * 1024 * 1024, "Content asset length");
                file.get("parts").forEach(ref -> {
                    reference(ref, "managed-extension-asset-part");
                    refs.add(ref);
                });
            }
        }
        return refs;
    }

    private static void requireAssets(JsonNode ref, Function<JsonNode, StoredResource> reader) {
        StoredResource manifest = read(reader, ref);
        JsonNode root = body(manifest);
        List<JsonNode> pages = assetReferences(manifest.kind(), root);
        Set<String> paths = new HashSet<>();
        long total = 0;
        for (JsonNode pageRef : pages) {
            StoredResource page = read(reader, pageRef);
            JsonNode pageBody = body(page);
            assetReferences(page.kind(), pageBody);
            for (JsonNode file : pageBody.get("files")) {
                require(paths.add(file.path("path").asText()) && paths.size() <= 256, "Duplicate or excessive content files");
                long length = 0;
                var digest = DigestUtils.getSha256Digest();
                for (JsonNode part : file.get("parts")) {
                    StoredResource bytes = read(reader, part);
                    require(bytes.byteLength() > 0, "Empty content part");
                    length += bytes.byteLength();
                    require(length <= file.path("byteLength").asLong(), "Content asset length conflicts");
                    digest.update(bytes.bytes());
                }
                require(length == file.path("byteLength").asLong()
                        && java.util.HexFormat.of().formatHex(digest.digest()).equals(file.path("digest").asText()), "Content asset digest conflicts");
                total += length;
                require(total <= 8 * 1024 * 1024, "Content assets exceed limit");
            }
        }
    }

    private static StoredResource read(Function<JsonNode, StoredResource> reader, JsonNode ref) {
        StoredResource resource = reader.apply(ref);
        require(resource != null && resource.schemaVersion() == 1 && resource.byteLength() <= 64 * 1024
                && resource.kind().equals(ref.path("kind").asText()) && resource.byteLength() == ref.path("byteLength").asLong(-1)
                && resource.digest().equals(ref.path("digest").asText()) && resource.bytes() != null
                && resource.bytes().length == resource.byteLength() && DigestUtils.sha256Hex(resource.bytes()).equals(resource.digest()), "Content resource conflicts");
        return resource;
    }

    private static JsonNode body(StoredResource resource) {
        JsonNode result = com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.parse(
                new String(resource.bytes(), java.nio.charset.StandardCharsets.UTF_8));
        require(result != null, "Invalid content resource");
        return result;
    }

    private static void reference(JsonNode ref, String kind) {
        ManagedExtensionRecords.durableRef(ref, "Content resource");
        require(kind.equals(ref.path("kind").asText()) && ref.path("schemaVersion").asInt() == 1, "Invalid content resource kind");
    }

    private static boolean safePath(String path) {
        return !path.isBlank() && path.length() <= 4096 && !path.startsWith("/") && !path.contains("\\") && !path.contains(":")
                && path.chars().noneMatch(c -> c < 32 || c == 127)
                && java.util.Arrays.stream(path.split("/", -1)).noneMatch(part -> part.isEmpty() || part.equals(".") || part.equals(".."));
    }

    private static void require(boolean valid, String message) {
        if (!valid) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
