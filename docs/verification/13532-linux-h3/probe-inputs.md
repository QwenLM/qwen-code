# Recorded probe inputs

These are the exact diagnostic inputs of the first, legacy-only native run. They do not patch production code. Environment-specific paths and the executed bundle digest are preserved as evidence. Copy the files into the indicated ignored `.qwen/acceptance-h3/` directory at the named production source, build its Java production classes and CLI, install native Node dependencies, and provide an isolated MySQL database. For another host, replace the owned paths and record the newly built bundle digest before checking it; do not describe an unmatched binary as the recorded binary.

The source check used a 5,042-file manifest over core/CLI src/**, Java src/main/** and four existing Node helpers. The manifest SHA256 was `a4aeadf5fbfbb8583ec1eec5b5e08cc0d4ff1f3c7ed0c3d49f6eca4168cd232b`. The first native log SHA256 was `6e9e30a15a5e32f58d014bc649c78130695bca3f28d7b852e5b38b0357531338`. This manifest excludes the separate #12904 test overlays and is not a claim that the entire guest tree is a clean checkout.

## Recreate the source manifest

In a checkout of the named production commit, generate the same manifest before copying the diagnostic inputs. This command reproduces its 5,042 paths and SHA256 above; run it from the repository root on Linux. / 在指定生产 commit 的 checkout 中、复制诊断输入前，于 Linux 仓库根目录生成清单。下方命令复现上述 5,042 个路径及清单摘要。

<!-- prettier-ignore -->
```sh
mkdir -p .qwen/acceptance-h3
git ls-tree -rz --name-only 669b2f0f91b0c787f7d8a26971c7c34210b935e1 -- \
  packages/core/src packages/cli/src \
  packages/sdk-java/qwencode/src/main \
  packages/sdk-java/runtime-broker/src/main \
  packages/sdk-java/managed-agent-server/src/main \
  integration-tests/fake-openai-server.ts \
  integration-tests/helpers/daemon-process.ts \
  integration-tests/helpers/hosted-harness-process.ts \
  integration-tests/scratch-dir.ts \
  | LC_ALL=C sort -z | xargs -0 sha256sum \
  > .qwen/acceptance-h3/exact-base-source.sha256
```

## Prepare Java classpath and script permissions

After installing the SDK and Broker artifacts as in the SDK Java workflow, build the server's production classes and write the classpath file used by the probe. The recorded environment uses Java 21 and Maven 3.9.9. This preparation was verified against the original classpath byte for byte; `--offline` may be added once the required dependencies/plugins are cached. / 按 SDK Java 工作流安装 SDK 与 Broker 构件后，构建服务端生产类并生成探测使用的 classpath 文件。当次环境为 Java 21、Maven 3.9.9；已验证新生成的 classpath 与原文件逐字节一致。依赖与 plugin 已缓存时可加 `--offline`。

<!-- prettier-ignore -->
```sh
mvn --batch-mode --no-transfer-progress \
  -f packages/sdk-java/managed-agent-server/pom.xml \
  -DskipTests compile dependency:build-classpath \
  -Dmdep.outputFile=target/acceptance-classpath.txt
chmod +x .qwen/acceptance-h3/run-gate.sh
# After copying the second-run inputs / 复制第二次输入之后：
chmod +x .qwen/acceptance-h3-publication/run-gate.sh
```

## Executed command — legacy control

The owned Lima VM supplied a non-root delegated systemd unit and a wrapper exporting `QWEN_MANAGED_HOOK_CGROUP_ROOT` from the actual unit cgroup. On a native Linux host, use an equivalent verified delegated unit; the wrapper is environment setup, not H3 evidence.

<!-- prettier-ignore -->
```sh
/Users/zzj/.qwen/tmp/managed-agent-two-issues-20261009/linux-env/lima-env.sh shell h3 \
  sudo systemd-run --quiet --wait --pipe --collect \
  --unit=qwen-h3-gate-20261009-0920 --uid=qwen \
  --property=Delegate=yes \
  --property=WorkingDirectory=/home/qwen/acceptance/12904 \
  /home/qwen/managed-env/delegate-run.sh \
  /home/qwen/acceptance/12904/.qwen/acceptance-h3/run-gate.sh \
  /home/qwen/acceptance/12904/packages/sdk-java/managed-agent-server/target/acceptance-classpath.txt \
  /home/qwen/acceptance/13532-run-20261009-0920
```

The SQL schema and credentials in these inputs belong only to the disposable acceptance database. The run directory must be new. `captureBytes` was absent in this first run. Background/Monitor refusal is the intended assertion; the foreground control must produce physical bytes. An exit code of 0 therefore proves the admission/control checks, not H3 readiness.

<details>
<summary>中文说明</summary>

下面保留首次 legacy 原生运行的准确诊断输入，没有修改生产代码。环境专用路径及实际执行的 bundle 摘要原样保留。复跑时将文件放入指定生产源码的忽略目录 `.qwen/acceptance-h3/`，构建 Java 生产类与 CLI、安装原生 Node 依赖，并提供独立 MySQL 数据库。换宿主时调整所拥有的路径，先记录新构建 bundle 的摘要再检查；不能把摘要不匹配的二进制称为当次已记录产物。

源码检查使用 5,042 个文件的清单，覆盖 core/CLI src/**、Java src/main/** 及四个既有 Node helpers；清单 SHA256：`a4aeadf5fbfbb8583ec1eec5b5e08cc0d4ff1f3c7ed0c3d49f6eca4168cd232b`。首次原生日志 SHA256：`6e9e30a15a5e32f58d014bc649c78130695bca3f28d7b852e5b38b0357531338`。清单排除了另一个 #12904 的测试覆盖文件，不能据此称整个 guest 目录为干净 checkout。

上方准确命令通过所拥有的 Lima VM 提供非 root 的 delegated systemd unit，wrapper 根据该 unit 的实际 cgroup 导出 `QWEN_MANAGED_HOOK_CGROUP_ROOT`。在原生 Linux 宿主使用等价且已验证的委派 unit；wrapper 属于环境准备，不是 H3 行为证据。

输入中的 SQL schema 与凭据只属于可丢弃的验收数据库。运行目录必须是新目录。首次运行未提供 `captureBytes`。预期断言是 background/Monitor 被拒绝，foreground 控制必须产生实际字节。因此退出码 0 只证明入口与控制检查，不能证明 H3 已就绪。下方代码块是实际输入原文，无需翻译标识符或命令。

</details>

## run-gate.sh

SHA256: `21c138ee0a2b772652a7a3c0255fba2cc3298982da8b61e06a6812d33f5c025f`

<!-- prettier-ignore -->
```sh
#!/bin/bash
set -euo pipefail
qa_source_root=/home/qwen/acceptance/12904
qa_classpath_file=$1
qa_run_directory=$2
cd "$qa_source_root"
sha256sum --status -c .qwen/acceptance-h3/exact-base-source.sha256
qa_bundle_sha=$(sha256sum dist/cli.js | cut -d' ' -f1)
test "$qa_bundle_sha" = 11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d
printf 'H3_SOURCE_MATCH files=%s sourceHead=%s bundleSha256=%s\n' "$(wc -l < .qwen/acceptance-h3/exact-base-source.sha256)" 669b2f0f91b0c787f7d8a26971c7c34210b935e1 "$qa_bundle_sha"
qa_classpath="packages/sdk-java/managed-agent-server/target/classes:$(cat "$qa_classpath_file")"
mkdir -p .qwen/acceptance-h3/classes
javac -cp "$qa_classpath" -d .qwen/acceptance-h3/classes .qwen/acceptance-h3/H3GateProbe.java
printf 'H3_LINUX %s\n' "$(uname -a)"
printf 'H3_DELEGATED_CGROUP %s\n' "$QWEN_MANAGED_HOOK_CGROUP_ROOT"
findmnt -no FSTYPE,OPTIONS /sys/fs/cgroup
java -cp ".qwen/acceptance-h3/classes:$qa_classpath" \
  -Dsource.head=669b2f0f91b0c787f7d8a26971c7c34210b935e1 \
  -Dnode.executable="$(command -v node)" \
  -Dmysql.url='jdbc:mysql://127.0.0.1:23060/qwen_13532?allowPublicKeyRetrieval=true&useSSL=false' \
  -Dmysql.user=root -Dmysql.password=qwen-acceptance-only \
  H3GateProbe "$qa_source_root" "$qa_run_directory"
printf 'H3_POST_PROBE_CGROUP_EVENTS\n'
cat "$QWEN_MANAGED_HOOK_CGROUP_ROOT/cgroup.events"
```

## H3GateProbe.java

SHA256: `3bdd01727541f77ed32f1927064bfe4578a0e55e9524aee73420ef95d82395f1`

<!-- prettier-ignore -->
```java
import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;

public class H3GateProbe {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toRealPath();
        Path temporary = Files.createDirectories(Path.of(args[1])).toRealPath();
        Path cli = root.resolve("dist/cli.js");
        Path legacyWorkspace = Files.createDirectory(temporary.resolve("legacy-workspace"));
        Files.createDirectory(temporary.resolve("runtime"), java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")));
        Path node = Path.of(System.getProperty("node.executable"));
        String head = System.getProperty("source.head");
        String tenant = "h3-gate-" + UUID.randomUUID();
        var arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getProperty("mysql.url"),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password"),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.durable-local-process=true",
                "--qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
                "--qwen.managed-agent.runtime-broker.verified-workspace-recovery-enabled=false",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + legacyWorkspace,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        var names = List.of("background", "monitor", "foreground");
        var workspaces = new ArrayList<Path>();
        for (int i = 0; i < names.size(); i++) {
            Path workspace = Files.createDirectory(temporary.resolve(names.get(i)));
            Files.createDirectory(workspace.resolve("child"));
            Files.setLastModifiedTime(workspace, FileTime.fromMillis(1));
            workspaces.add(workspace);
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + i + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + i);
            arguments.add(prefix + "root=" + workspace);
        }
        try (var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(arguments.toArray(String[]::new))) {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
            var sessions = new ArrayList<Map<String, Object>>();
            for (int i = 0; i < names.size(); i++) {
                String workspaceId = "workspace-" + i;
                jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?,"
                        + " 'Workspace', ?, ?, 'ACTIVE')", tenant, workspaceId, "storage-" + i,
                        WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
                jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES (?, ?, ?, 'OPERATOR')", tenant, workspaceId, "actor".getBytes(StandardCharsets.UTF_8));
                var created = store.insertWorkspaceSessionCommand(tenant, "actor", "create-" + i,
                        "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection(workspaceId, "child"));
                sessions.add(Map.of("sessionId", created.sessionId(), "workspaceId", workspaceId,
                        "scenario", names.get(i), "directory", workspaces.get(i).resolve("child").toString()));
            }
            Path config = temporary.resolve("driver.json");
            String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(cli)));
            new ObjectMapper().writeValue(config.toFile(), Map.of("tenantId", tenant, "sessions", sessions,
                    "sourceHead", head, "bundleSha256", sha,
                    "storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort(),
                    "brokerUrl", spring.getBean(EmbeddedRuntimeBroker.class).getBaseUri().toString()));
            System.out.println("H3_ENV " + Map.of("head", head, "brokerPid", ProcessHandle.current().pid(),
                    "cgroupRoot", System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT"),
                    "database", jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine")));
            Process driver = new ProcessBuilder(node.toString(), "--import", "tsx", ".qwen/acceptance-h3/hosted-gate-driver.ts", config.toString())
                    .directory(root.toFile()).inheritIO().start();
            try {
                if (!driver.waitFor(300, TimeUnit.SECONDS)) throw new IllegalStateException("H3 driver timeout");
                if (driver.exitValue() != 0) throw new IllegalStateException("H3 driver exited " + driver.exitValue());
                for (var session : sessions) {
                    String id = session.get("sessionId").toString();
                    System.out.println("H3_SQL " + new ObjectMapper().writeValueAsString(Map.of(
                            "scenario", session.get("scenario"), "sessionId", id,
                            "executions", jdbc.queryForList("SELECT execution_call_id, execution_state, result_json FROM qwen_tool_execution WHERE harness_session_id = ?", id),
                            "resources", jdbc.queryForList("SELECT kind, byte_length FROM qwen_managed_session_resource WHERE tenant_id = ? AND session_id = ?", tenant, id),
                            "publications", jdbc.queryForList("SELECT state, capture_bytes, producer_bytes FROM qwen_tool_publication WHERE tenant_id = ? AND session_id = ?", tenant, id),
                            "artifacts", jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_artifact a JOIN managed_agent_tool_result r ON a.result_id = r.result_id WHERE r.tenant_id = ? AND r.session_id = ?", Long.class, tenant, id))));
                }
                System.out.println("H3_PUBLIC_CHAIN_BLOCKED_BY_UNCHANGED_ADMISSION_GATES");
            } finally {
                if (driver.isAlive()) driver.destroyForcibly();
            }
        }
    }
}
```

## hosted-gate-driver.ts

SHA256: `fbd79d2992f7b9cbf1bbc7b9ba9d2e7bddcc88e04e82f45477f6f21991c475eb`

<!-- prettier-ignore -->
```typescript
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../../integration-tests/fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from '../../integration-tests/helpers/hosted-harness-process.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const requests: Array<Record<string, unknown>> = [];
const model = await startFakeOpenAIServer(({ body }) => {
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const user = messages.filter(message => message.role === 'user').at(-1);
  const promptText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
  const scenario = promptText.match(/H3_CASE_(foreground|background|monitor)/)?.[1];
  const tools = body.tools as Array<{ function?: { name: string } }> | undefined;
  requests.push({ scenario, advertised: tools?.map(tool => tool.function?.name), messages: messages.filter(message => message.role === 'tool') });
  if (messages.at(-1)?.role === 'tool') return { content: 'H3_GATE_TURN_COMPLETE' };
  if (scenario === 'foreground') return { toolCalls: [fakeToolCall('run_shell_command', { command: 'printf H3_FOREGROUND_CONTROL > foreground-proof.txt; printf H3_FOREGROUND_CONTROL' }, 'gate-foreground')] };
  if (scenario === 'background') return { toolCalls: [fakeToolCall('run_shell_command', { command: 'printf H3_BACKGROUND_UNEXPECTED > background-proof.txt; sleep 30', is_background: true }, 'gate-background')] };
  if (scenario === 'monitor') return { toolCalls: [fakeToolCall('monitor', { command: 'printf H3_MONITOR_UNEXPECTED > monitor-proof.txt; sleep 30', idle_timeout_ms: 1000, max_events: 1 }, 'gate-monitor')] };
  throw new Error(`Unknown scenario ${String(user?.content)}`);
});
const cli = new HostedHarnessProcess();
let clientId = '';
async function json(route: string, body?: unknown, expected = 200) {
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${route}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
try {
  await cli.start(model.baseUrl, { extraArgs: ['--managed-runtime-broker-url', config.brokerUrl, '--managed-runtime-broker-token', 'hosted-tools-broker-token'] });
  console.log(`H3_PACKAGED_HARNESS ${JSON.stringify({ pid: cli.child?.pid, bootId: cli.bootId, sourceHead: config.sourceHead, bundleSha256: config.bundleSha256 })}`);
  for (const session of config.sessions) {
    const created = await json('/session', {
      sessionId: session.sessionId,
      sessionScope: 'thread',
      managedSessionStore: { baseUrl: config.storeUrl, tenantId: config.tenantId, workspaceId: session.workspaceId, writerId: cli.bootId, leaseDurationMs: 60000 },
      toolProfile: 'hosted-workspace-shell/1',
    });
    clientId = created.clientId;
    const blocks = [{ type: 'text', text: `H3_CASE_${session.scenario}` }];
    const promptId = randomUUID();
    await json(`/session/${session.sessionId}/prompt`, { promptId, prompt: blocks, payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}` }, 202);
    await waitUntil(async () => !(await json(`/session/${session.sessionId}/status`)).hasActivePrompt, 90000);
    const status = await json(`/session/${session.sessionId}/status`);
    const transcript = await json(`/session/${session.sessionId}/transcript?cursor=0&limit=256`);
    console.log(`H3_CASE ${JSON.stringify({ scenario: session.scenario, sessionId: session.sessionId, status, terminal: transcript.events.filter((event: { type: string }) => event.type.startsWith('turn_')), toolReplies: requests.filter(request => request.scenario === session.scenario && Array.isArray(request.messages) && request.messages.length > 0) })}`);
    const observedToolReplies = JSON.stringify(requests.filter(request => request.scenario === session.scenario && Array.isArray(request.messages) && request.messages.length > 0));
    if (session.scenario === 'foreground') assert.equal(await readFile(path.join(session.directory, 'foreground-proof.txt'), 'utf8'), 'H3_FOREGROUND_CONTROL');
    else {
      await assert.rejects(access(path.join(session.directory, `${session.scenario}-proof.txt`)));
      assert.match(observedToolReplies, session.scenario === 'background' ? /Hosted Shell requires (?:one foreground command|a foreground command)/ : /Hosted Monitor is unavailable/);
    }
    assert.equal(status.recoveryBlocked, false);
    await json(`/session/${session.sessionId}/detach`, {}, 204);
    clientId = '';
  }
  console.log('H3_PUBLIC_GATE_OBSERVED');
} catch (error) {
  console.error(cli.output);
  throw error;
} finally {
  await cli.close();
  await model.close();
}
```

## Executed command — publication parameters

The second run reused the unchanged production classes, source manifest and packaged bundle. The diagnostic inputs below differ only in the ignored probe directory, requested Shell profile/capture limit and recording the foreground blocked state instead of asserting a successful foreground file. The publication feature remained disabled. The original exact input hashes are retained above; these separate hashes identify the second run.

<!-- prettier-ignore -->
```sh
/Users/zzj/.qwen/tmp/managed-agent-two-issues-20261009/linux-env/lima-env.sh shell h3 sudo systemd-run --quiet --wait --pipe --collect --unit=qwen-h3-publication-gate-20261009-1007 --uid=qwen --property=Delegate=yes --property=WorkingDirectory=/home/qwen/acceptance/12904 /home/qwen/managed-env/delegate-run.sh /home/qwen/acceptance/12904/.qwen/acceptance-h3-publication/run-gate.sh /home/qwen/acceptance/12904/packages/sdk-java/managed-agent-server/target/acceptance-classpath.txt /home/qwen/acceptance/13532-publication-run-20261009-1007
```

The foreground recorder deliberately does not assert success: its `recoveryBlocked`, missing marker and SQL `not_started` result are acceptance evidence of a blocked control, not a passing H3 result.

<details><summary>中文说明</summary>

第二次运行复用了未修改的生产类、源码清单及打包产物。下方诊断输入只调整忽略目录、Shell profile/capture 上限，并记录 foreground 的阻塞状态，而不再断言成功写入前台文件。publication 功能仍关闭。首次输入摘要保留在上方，下面另列第二次运行的输入摘要。

前台记录器刻意不把成功作为断言：`recoveryBlocked`、缺失的 marker 及 SQL `not_started` 是控制场景受阻的验收证据，不能称为 H3 通过。

</details>

## Second-run input deltas

Copy the three original files and source manifest into `.qwen/acceptance-h3-publication/`, then apply these deltas to that copy. / 将原始三个文件及源码清单复制到 `.qwen/acceptance-h3-publication/`，再对副本应用以下差异。

### run-gate.sh

Second-run SHA256: `f472bf668dac01ea0c68e1253cd078080741b334fcf357ae8132aaa2052e6cf2`

<!-- prettier-ignore -->
```diff
--- original/run-gate.sh
+++ publication/run-gate.sh
@@ -4,17 +4,17 @@
 qa_classpath_file=$1
 qa_run_directory=$2
 cd "$qa_source_root"
-sha256sum --status -c .qwen/acceptance-h3/exact-base-source.sha256
+sha256sum --status -c .qwen/acceptance-h3-publication/exact-base-source.sha256
 qa_bundle_sha=$(sha256sum dist/cli.js | cut -d' ' -f1)
 test "$qa_bundle_sha" = 11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d
-printf 'H3_SOURCE_MATCH files=%s sourceHead=%s bundleSha256=%s\n' "$(wc -l < .qwen/acceptance-h3/exact-base-source.sha256)" 669b2f0f91b0c787f7d8a26971c7c34210b935e1 "$qa_bundle_sha"
+printf 'H3_SOURCE_MATCH files=%s sourceHead=%s bundleSha256=%s\n' "$(wc -l < .qwen/acceptance-h3-publication/exact-base-source.sha256)" 669b2f0f91b0c787f7d8a26971c7c34210b935e1 "$qa_bundle_sha"
 qa_classpath="packages/sdk-java/managed-agent-server/target/classes:$(cat "$qa_classpath_file")"
-mkdir -p .qwen/acceptance-h3/classes
-javac -cp "$qa_classpath" -d .qwen/acceptance-h3/classes .qwen/acceptance-h3/H3GateProbe.java
+mkdir -p .qwen/acceptance-h3-publication/classes
+javac -cp "$qa_classpath" -d .qwen/acceptance-h3-publication/classes .qwen/acceptance-h3-publication/H3GateProbe.java
 printf 'H3_LINUX %s\n' "$(uname -a)"
 printf 'H3_DELEGATED_CGROUP %s\n' "$QWEN_MANAGED_HOOK_CGROUP_ROOT"
 findmnt -no FSTYPE,OPTIONS /sys/fs/cgroup
-java -cp ".qwen/acceptance-h3/classes:$qa_classpath" \
+java -cp ".qwen/acceptance-h3-publication/classes:$qa_classpath" \
   -Dsource.head=669b2f0f91b0c787f7d8a26971c7c34210b935e1 \
   -Dnode.executable="$(command -v node)" \
   -Dmysql.url='jdbc:mysql://127.0.0.1:23060/qwen_13532?allowPublicKeyRetrieval=true&useSSL=false' \
```

### H3GateProbe.java

Second-run SHA256: `54cc933222a8deb097c4425b6fd3bda4b09de6a2abd3d5991f3ebe69928f205b`

<!-- prettier-ignore -->
```diff
--- original/H3GateProbe.java
+++ publication/H3GateProbe.java
@@ -91,7 +91,7 @@
             System.out.println("H3_ENV " + Map.of("head", head, "brokerPid", ProcessHandle.current().pid(),
                     "cgroupRoot", System.getenv("QWEN_MANAGED_HOOK_CGROUP_ROOT"),
                     "database", jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine")));
-            Process driver = new ProcessBuilder(node.toString(), "--import", "tsx", ".qwen/acceptance-h3/hosted-gate-driver.ts", config.toString())
+            Process driver = new ProcessBuilder(node.toString(), "--import", "tsx", ".qwen/acceptance-h3-publication/hosted-gate-driver.ts", config.toString())
                     .directory(root.toFile()).inheritIO().start();
             try {
                 if (!driver.waitFor(300, TimeUnit.SECONDS)) throw new IllegalStateException("H3 driver timeout");
```

### hosted-gate-driver.ts

Second-run SHA256: `815a510aaa829bfea8d6a315a6c20eb7d640a3ee3e810c8f1e037252b166f791`

<!-- prettier-ignore -->
```diff
--- original/hosted-gate-driver.ts
+++ publication/hosted-gate-driver.ts
@@ -39,7 +39,8 @@
       sessionId: session.sessionId,
       sessionScope: 'thread',
       managedSessionStore: { baseUrl: config.storeUrl, tenantId: config.tenantId, workspaceId: session.workspaceId, writerId: cli.bootId, leaseDurationMs: 60000 },
-      toolProfile: 'hosted-workspace-shell/1',
+      toolProfile: 'hosted-workspace-shell/2',
+      captureBytes: 64 * 1024 * 1024,
     });
     clientId = created.clientId;
     const blocks = [{ type: 'text', text: `H3_CASE_${session.scenario}` }];
@@ -50,12 +51,12 @@
     const transcript = await json(`/session/${session.sessionId}/transcript?cursor=0&limit=256`);
     console.log(`H3_CASE ${JSON.stringify({ scenario: session.scenario, sessionId: session.sessionId, status, terminal: transcript.events.filter((event: { type: string }) => event.type.startsWith('turn_')), toolReplies: requests.filter(request => request.scenario === session.scenario && Array.isArray(request.messages) && request.messages.length > 0) })}`);
     const observedToolReplies = JSON.stringify(requests.filter(request => request.scenario === session.scenario && Array.isArray(request.messages) && request.messages.length > 0));
-    if (session.scenario === 'foreground') assert.equal(await readFile(path.join(session.directory, 'foreground-proof.txt'), 'utf8'), 'H3_FOREGROUND_CONTROL');
+    if (session.scenario === 'foreground') console.log('H3_PUBLICATION_CONTROL ' + JSON.stringify({ requestedProfile: 'hosted-workspace-shell/2', captureBytes: 64 * 1024 * 1024, proof: await readFile(path.join(session.directory, 'foreground-proof.txt'), 'utf8').catch(error => ({ error: error.code })), status, observedToolReplies }));
     else {
       await assert.rejects(access(path.join(session.directory, `${session.scenario}-proof.txt`)));
       assert.match(observedToolReplies, session.scenario === 'background' ? /Hosted Shell requires (?:one foreground command|a foreground command)/ : /Hosted Monitor is unavailable/);
     }
-    assert.equal(status.recoveryBlocked, false);
+    if (session.scenario !== 'foreground') assert.equal(status.recoveryBlocked, false);
     await json(`/session/${session.sessionId}/detach`, {}, 204);
     clientId = '';
   }
```

## Publication output excerpt

<!-- prettier-ignore -->
```text
H3_CASE {"scenario":"background","sessionId":"271a9306-d6f2-4218-8e6c-e19dbdcd358e","status":{"sessionId":"271a9306-d6f2-4218-8e6c-e19dbdcd358e","hasActivePrompt":false,"recoveryBlocked":false},"terminal":[{"v":1,"id":14,"type":"turn_complete","promptId":"f023661d-1e28-45d2-bde3-ce60a0ea117a","data":{"sessionId":"271a9306-d6f2-4218-8e6c-e19dbdcd358e","promptId":"f023661d-1e28-45d2-bde3-ce60a0ea117a","stopReason":"end_turn"}}],"toolReplies":[{"scenario":"background","advertised":["read_file","write_file","edit","run_shell_command","monitor","glob","agent"],"messages":[{"role":"tool","tool_call_id":"gate-background","content":[{"type":"text","text":"Hosted Shell requires one foreground command."}]}]}]}
H3_CASE {"scenario":"monitor","sessionId":"029c0e95-89a4-4f80-a291-f727bc317ed9","status":{"sessionId":"029c0e95-89a4-4f80-a291-f727bc317ed9","hasActivePrompt":false,"recoveryBlocked":false},"terminal":[{"v":1,"id":14,"type":"turn_complete","promptId":"d3364dc4-5f81-4a86-bc49-7a046e276b73","data":{"sessionId":"029c0e95-89a4-4f80-a291-f727bc317ed9","promptId":"d3364dc4-5f81-4a86-bc49-7a046e276b73","stopReason":"end_turn"}}],"toolReplies":[{"scenario":"monitor","advertised":["read_file","write_file","edit","run_shell_command","monitor","glob","agent"],"messages":[{"role":"tool","tool_call_id":"gate-monitor","content":[{"type":"text","text":"Hosted Monitor is unavailable on this Session profile; read output through the task surface instead."}]}]}]}
H3_CASE {"scenario":"foreground","sessionId":"c1da0c42-fe0f-4cee-92e1-b7520e755ee9","status":{"sessionId":"c1da0c42-fe0f-4cee-92e1-b7520e755ee9","hasActivePrompt":false,"recoveryBlocked":true},"terminal":[],"toolReplies":[]}
H3_PUBLICATION_CONTROL {"requestedProfile":"hosted-workspace-shell/2","captureBytes":67108864,"proof":{"error":"ENOENT"},"status":{"sessionId":"c1da0c42-fe0f-4cee-92e1-b7520e755ee9","hasActivePrompt":false,"recoveryBlocked":true},"observedToolReplies":"[]"}
```
