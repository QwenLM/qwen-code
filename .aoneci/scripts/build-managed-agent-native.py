#!/usr/bin/env python3
"""Build the managed-agent native artifacts directly from the current qwen-code checkout.

Replaces the managed-sdk candidate/patch producers: the source of truth is the pipeline's
own Git checkout, identified by its full HEAD SHA and recorded in PROVENANCE.json.

Modes:
  package - SDK install (skipTests) + managed server package + assembly
  verify  - SDK install + one combined Surefire/Failsafe clean verify with Checkstyle on two
            disposable MySQL 8.4 containers, then assembly

Output layout: <out>/artifact (assembled server JAR/POM + sdk/ + assembly-validation.json +
PROVENANCE.json), <out>/steps.json, <out>/<step>.log, <out>/reports/<label>/...
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ASSEMBLER = Path(__file__).resolve().parent / "assemble-managed-agent.py"


def source_revision():
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("git rev-parse HEAD must be a full lowercase 40-hex SHA: " + revision)
    return revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["verify", "package"], default="verify")
    parser.add_argument("--release-id", required=True, help="Immutable release id for this build")
    parser.add_argument("--source-sha", required=True, help="Full 40-hex qwen-code commit to build")
    parser.add_argument("--sdk-version", help="Preview SDK coordinate version; defaults to the release id")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.release_id):
        raise SystemExit("--release-id must be a non-empty artifact-safe id")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise SystemExit("--source-sha must be a full lowercase 40-hex commit")
    sdk_version = args.sdk_version or args.release_id
    revision = source_revision()
    if revision != args.source_sha:
        raise SystemExit("checkout does not match --source-sha: " + revision)

    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    steps = []
    containers = []

    def run(name, command, timeout=7200):
        start = time.monotonic()
        log = output / (name + ".log")
        # Never write the disposable MySQL password into logs or steps.json.
        safe_command = ["-Dmysql.password=<disposable-test-password>" if value.startswith("-Dmysql.password=")
                        else value for value in command] if name.startswith("native-") else None
        with log.open("w") as stream:
            if safe_command:
                stream.write(json.dumps({"command": safe_command}) + "\n")
                stream.flush()
            try:
                code = subprocess.run(command, cwd=REPO, stdout=stream, stderr=subprocess.STDOUT,
                                      timeout=timeout).returncode
            except subprocess.TimeoutExpired:
                code = 124
        steps.append({"step": name, "exitCode": code, "seconds": round(time.monotonic() - start, 3)})
        if safe_command:
            steps[-1]["command"] = safe_command
        (output / "steps.json").write_text(json.dumps(steps, indent=2) + "\n")
        print(name + ": " + str(code), flush=True)
        if code:
            print(log.read_text()[-10000:], flush=True)
            raise SystemExit(code)

    def reports(label):
        for path in REPO.glob("packages/**/target/*-reports"):
            relative = path.relative_to(REPO)
            shutil.copytree(path, output / "reports" / label / relative, dirs_exist_ok=True)

    def require_executed_report(name, suite):
        paths = list(REPO.glob("packages/managed-agent-server/verification/target/"
                               + name + "/TEST-*." + suite + ".xml"))
        if len(paths) != 1:
            raise RuntimeError("Expected exactly one report for " + suite + ": " + str(paths))
        root = ET.parse(paths[0]).getroot()
        if int(root.get("tests", "0")) < 1 or any(int(root.get(k, "0")) for k in ("failures", "errors", "skipped")):
            raise RuntimeError("Required suite did not fully pass: " + str(paths[0]))

    def prepare_git():
        version = subprocess.check_output(["git", "--version"], text=True)
        match = re.search(r"(\d+)\.(\d+)", version)
        if match and tuple(map(int, match.groups())) >= (2, 40):
            return
        for tool in ("make", "cc"):
            if not shutil.which(tool):
                raise RuntimeError("Missing Git build prerequisite: " + tool)
        if not shutil.which("curl-config"):
            prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
            manager = shutil.which("dnf") or shutil.which("yum")
            if not manager:
                raise RuntimeError("Git build requires development headers and a package manager")
            run("git-build-headers", prefix + [manager, "install", "-y", "libcurl-devel",
                "openssl-devel", "zlib-devel", "expat-devel"], timeout=1800)
        archive = output / "git-2.48.2.tar.xz"
        if not archive.exists():
            with urllib.request.urlopen("https://www.kernel.org/pub/software/scm/git/git-2.48.2.tar.xz", timeout=900) as source, archive.open("wb") as target:
                shutil.copyfileobj(source, target)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != "30ce5660fc6be0453ab0e15ba3f2b69f2325cde0bb447ad2ee1b559f2999e494":
            raise RuntimeError("Pinned Git source checksum mismatch")
        with tarfile.open(archive) as bundle:
            bundle.extractall(output, filter="data")
        git_prefix = output / "git-toolchain"
        run("git-toolchain-install", ["make", "-C", str(output / "git-2.48.2"), "-j8",
            "prefix=" + str(git_prefix), "NO_GETTEXT=YesPlease", "NO_TCLTK=YesPlease", "install"], timeout=1800)
        os.environ["PATH"] = str(git_prefix / "bin") + os.pathsep + os.environ["PATH"]

    try:
        if args.mode == "verify":
            prepare_git()
        # 沿用现有 native producer 的包镜像，保留 Corepack 签名与锁文件校验。
        os.environ["COREPACK_NPM_REGISTRY"] = "https://registry.npmmirror.com"
        os.environ["npm_config_registry"] = "https://registry.npmmirror.com"
        os.environ["QWEN_SKIP_PREPARE"] = "1"
        node_prerequisites = ["corepack", "pnpm", "--config.registry=https://registry.npmmirror.com",
                              "install", "--frozen-lockfile", "--prefer-offline", "--reporter=append-only"]
        if args.mode == "verify":
            run("node-prerequisites", node_prerequisites)
        common = ["mvn", "-B", "-ntp", "-Dmaven.javadoc.skip=true", "-Dgpg.skip=true"]
        run("sdk-install", common + ["-f", "packages/sdk-java/qwencode/pom.xml"]
            + (["-Dmaven.test.skip=true"] if args.mode == "package" else []) + ["install"])
        native = common + ["-f", "packages/managed-agent-server/pom.xml"]
        if args.mode == "package":
            # The parallel runtime producer owns the JavaScript build gate. Native packaging
            # consumes only Maven outputs and checked-in resources.
            run("native-package", native + ["--fail-at-end", "-Dmaven.test.skip=true", "package"])
            validation = "SDK and native compile/package with tests skipped; native tests pending verify run"
        else:
            ports = []
            for fork in (1, 2):
                name = "managed-release-mysql-" + str(os.getpid()) + "-" + str(fork)
                containers.append(name)
                run("mysql-start-" + str(fork), ["docker", "run", "--detach", "--name", name,
                    "--publish", "127.0.0.1::3306", "--mount", "type=tmpfs,destination=/var/lib/mysql",
                    "--env", "MYSQL_ROOT_PASSWORD=runtime-broker", "mysql:8.4.6",
                    "--innodb-use-native-aio=0", "--skip-log-bin"])
                for attempt in range(60):
                    probe = subprocess.run(["docker", "exec", name, "mysqladmin", "ping", "--host=127.0.0.1",
                                            "--user=root", "--password=runtime-broker", "--silent"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if probe.returncode == 0:
                        break
                    time.sleep(2)
                else:
                    run("mysql-diagnostics-" + str(fork), ["docker", "logs", name])
                    raise RuntimeError("MySQL 8.4 readiness failed")
                run("mysql-configure-" + str(fork), ["docker", "exec", name, "sh", "-c",
                    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --execute="SET GLOBAL max_allowed_packet=134217728; SELECT VERSION(), @@GLOBAL.max_allowed_packet, @@GLOBAL.innodb_use_native_aio, @@GLOBAL.log_bin"'])
                checked = subprocess.check_output(["docker", "exec", name, "sh", "-c",
                    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --skip-column-names --execute="SELECT VERSION() LIKE \'8.4.%\' AND @@GLOBAL.max_allowed_packet >= 134217728 AND @@GLOBAL.innodb_use_native_aio = 0 AND @@GLOBAL.log_bin = 0"'], text=True).strip()
                if checked != "1":
                    raise RuntimeError("MySQL version or required server settings do not match")
                port = subprocess.check_output(["docker", "inspect", "--format",
                    '{{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostPort}}', name], text=True).strip()
                ports.append(port)
            url = lambda port: "jdbc:mysql://127.0.0.1:" + port + "/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false"
            # Combined verify: Surefire (H2) and Failsafe (real MySQL 8.4) run in one
            # `clean verify`, avoiding the double compile of a two-pass approach.
            run("native-full-verify", native + ["-Pmysql-integration", "-Dmysql.integration.forks=2",
                "-Dmysql.url=" + url(ports[0]), "-Dmysql.url.1=" + url(ports[0]),
                "-Dmysql.url.2=" + url(ports[1]), "-Dmysql.user=root", "-Dmysql.password=runtime-broker",
                "clean", "verify", "checkstyle:check"])
            require_executed_report("surefire-reports", "ManagedModelSelectionTest")
            require_executed_report("failsafe-reports", "ManagedSessionModelConfigMySqlIT")
            reports("verify")
            validation = "SDK install; one combined full Surefire/Failsafe MySQL 8.4 clean verify with Checkstyle"
        artifact = output / "artifact"
        run("assemble", [sys.executable, str(ASSEMBLER), "--source", str(REPO),
            "--out", str(artifact), "--revision", revision, "--version", args.release_id,
            "--sdk-version", sdk_version])
        validation_report = json.loads((artifact / "assembly-validation.json").read_text())
        (artifact / "PROVENANCE.json").write_text(json.dumps({
            "producer": "native",
            "releaseId": args.release_id,
            "mode": args.mode,
            "sourceRevision": revision,
            "sdkVersion": sdk_version,
            "coordinate": validation_report["coordinate"],
            "jarSha256": validation_report["jarSha256"],
            "pomSha256": validation_report["pomSha256"],
            "sdkJarSha256": validation_report["sdkJarSha256"],
            "sdkPomSha256": validation_report["sdkPomSha256"],
            "schemaSha256": validation_report["schemaSha256"],
            "validation": validation,
            "steps": [{"step": step["step"], "exitCode": step["exitCode"], "seconds": step["seconds"]}
                      for step in steps],
        }, indent=2) + "\n")
    finally:
        reports("final")
        for name in containers:
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
