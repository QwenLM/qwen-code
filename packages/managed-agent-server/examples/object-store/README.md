# Object storage plugins

[English](README.md) | [简体中文](README.zh-CN.md)

This standalone example depends only on same-version `qwen-managed-agent-contracts` (provided scope). It implements `example-local` for a filesystem supporting atomic hard links and directory fsync. It demonstrates SPI packaging; filesystem and failure qualification remain the deployer's responsibility. Use a durable directory shared by every Server, Broker and operator process that needs the same objects. A directory local to one container is insufficient for a multi-host deployment.

## Implement and package

Implement `ImmutableObjectStoreFactory` and `ImmutableObjectStore`. Register the factory's fully qualified class name in `META-INF/services/com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStoreFactory`. Provider names are unique, lowercase identifiers. Factories validate their options before constructing clients. The loader validates the resulting store and owns its close lifecycle.

The stable identity must include the provider and physical namespace, remain unchanged across credential rotation and restarts, and contain no credentials. Changing the bucket, region or namespace changes this identity. Each external resource persists `store_id`; a mismatch refuses access instead of resolving an old key in a new backend.

`putIfAbsent` performs one physical create, never overwrites and never exposes partial bytes. Do not hide write retries. A lost response after a possible create is `WRITE_OUTCOME_UNKNOWN`; Server reconciles the original key. Report `ALREADY_EXISTS`, `NOT_FOUND`, `ACCESS_DENIED` and `UNAVAILABLE` distinctly. Check the supplied guard before every backend request/retry and while streaming. Guard exceptions must abort work. A successful create is fully readable; delete targets exactly the supplied key and treats absence as success. Close streams and connections, including on exceptions.

From this example directory, with matching contracts already installed into your isolated Maven repository:

```bash
mvn -Dmaven.repo.local=/path/to/task-m2 package
```

Do not package another copy of contracts or Spring in the plugin. Include the plugin's own runtime dependencies in the deployment classpath. The automated plugin test also compiles this example with only contracts on the compiler classpath and tests its JAR in a classloader without Spring or OSS.

## Configure and launch

All flags below default to false. Use the same provider and options for Server, Broker and maintenance tools; no OSS settings are needed for `example-local`.

```yaml
qwen:
  managed-agent:
    object-store:
      provider: example-local
      provider-options:
        directory: /srv/qwen/objects
      resource-writes-enabled: false
      gc-enabled: false
      deletion-grace: 24h
      journal-cold-storage-enabled: false
      journal-eviction-enabled: false
```

The built-in provider is `aliyun-oss`, with `endpoint`, `region`, and `bucket` options and the existing Alibaba Cloud environment-variable credentials provider. Its endpoint is a fixed regional HTTPS endpoint (for example `https://oss-cn-hangzhou.aliyuncs.com`); its bucket must be private and must never have enabled versioning. These restrictions belong to this adapter, not to the SPI. An explicit unknown provider, duplicate registration, or incomplete configuration fails startup. The legacy Tool Publication OSS configuration remains available when no generic provider is selected.

For a plain Java distribution, place contracts, the application, the plugin and all dependencies on `-cp`. For the executable Spring Boot JAR, use `PropertiesLauncher` explicitly:

```bash
java \
  -Dloader.path=/opt/qwen/plugins/managed-local-object-store-0.1.0-alpha.jar,/opt/qwen/plugins/dependencies/ \
  -Dloader.main=com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication \
  -cp /opt/qwen/qwen-managed-agent-server-exec.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher
```

Replace the executable JAR path with the artifact produced by your build. `java -jar` does not automatically load arbitrary plugin directories. Discovery happens only at startup; no hot loading, plugin download or online backend switching is supported.

For the standalone tools, use the same launcher/classpath and choose `WorkspaceRecoveryMain`, `WorkspaceMigrationMain`, `WorkspaceCsiRuntimeMain` or `WorkspaceCsiWorkerAckMain` under `com.alibaba.qwen.code.managedagent.maintenance` as `loader.main`. Preserve each tool's documented arguments, JDBC configuration and offline checks. These mains read generic provider configuration from Java system properties or environment, not a Spring Boot `application.yml`. For example:

```bash
java \
  -Dqwen.managed-agent.object-store.provider=example-local \
  -Dqwen.managed-agent.object-store.provider-options.directory=/srv/qwen/objects \
  -Dloader.path=/opt/qwen/plugins/managed-local-object-store-0.1.0-alpha.jar \
  -Dloader.main=com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryMain \
  -cp /opt/qwen/qwen-managed-agent-server-exec.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher inspect /path/to/request.json
```

Inspection that only reads the SQL operation ledger does not open a backend. Capture/verify/recovery paths load and close the same factory implementation as the service.

## Contract qualification and rollout

Run the reusable contract check against a disposable namespace, using the example JAR plus the provider being qualified and its dependencies:

```bash
java \
  -Dobject-store.option.directory=/tmp/qwen-object-contract \
  -cp /path/to/contracts.jar:/path/to/managed-local-object-store-0.1.0-alpha.jar \
  example.ObjectStoreContractCheck example-local
```

Replace the provider and `object-store.option.*` properties to exercise another implementation. The check covers concurrent create, overwrite refusal, interrupted source, guarded/bounded read, namespace identity across reopening, and idempotent deletion. It creates unique test keys and removes the completed object. It does not simulate backend process crashes, lost PUT/DELETE responses, delayed visibility or authorization expiry during a network retry. Add those failure gates for each actual backend; the memory provider/H2 suite is not production qualification.

Deploy storage-version-6 readers before enabling `resource-writes-enabled`. CSI object resources require `csi-files-retirement/4`. Enable GC separately. Enable `journal-cold-storage-enabled` first to upload and verify packs while retaining SQL bodies, then enable `journal-eviction-enabled` after qualification. Automatic candidates require seven days of cooling and at least 32 MiB of journal bodies. Turning off new writes/cold storage preserves reads, reconciliation, hydration and independently enabled GC. Roll back to a compatible binary with these flags disabled; an older reader cannot serve existing external data.

See the [design](../../../../docs/design/2026-11-10-managed-object-storage.md) for reference ownership, leases, epochs and acceptance criteria.
