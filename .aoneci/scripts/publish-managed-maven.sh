#!/usr/bin/env bash
set -euo pipefail
set +x

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

source_repository="${GITHUB_REPOSITORY:-https://github.com/QwenLM/qwen-code.git}"
source_branch="${MANAGED_GITHUB_BRANCH:-}"
source_branch="${source_branch#refs/heads/}"
publish_mode="${MANAGED_PUBLISH_MODE:-release}"
if [[ "$publish_mode" != release && "$publish_mode" != snapshot ]]; then
  echo 'MANAGED_PUBLISH_MODE must be release or snapshot.' >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo 'The checkout has tracked changes; refusing to publish.' >&2
  exit 2
fi

umask 077
publish_workdir="$(mktemp -d)"
pom_backup="$publish_workdir/pom-backup"
pom_paths=()
cleanup() {
  status=$?
  trap - EXIT
  for pom in "${pom_paths[@]}"; do
    cp "$pom_backup/$pom" "$pom"
  done
  rm -rf "$publish_workdir"
  exit "$status"
}
trap cleanup EXIT

pom_version() {
  python3 - "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET

namespace = "{http://maven.apache.org/POM/4.0.0}"
print(ET.parse(sys.argv[1]).getroot().findtext(namespace + "version"))
PY
}

sdk_version="$(pom_version packages/sdk-java/qwencode/pom.xml)"
managed_version="$(pom_version packages/managed-agent-server/pom.xml)"
if [[ "$publish_mode" != snapshot && ( "$sdk_version" != *-SNAPSHOT || "$managed_version" != *-SNAPSHOT ) &&
  "${MANAGED_RELEASE_APPROVED:-}" != 'true' ]]; then
  echo 'A non-SNAPSHOT publish requires releaseApproved=true.' >&2
  exit 2
fi

source_sha="$(git rev-parse HEAD)"
echo "Preparing $publish_mode publication for SDK $sdk_version and Managed Agent $managed_version from $source_sha"

settings="$publish_workdir/settings.xml"
if [[ "${MANAGED_MAVEN_USE_SETUP_SETTINGS:-false}" == 'true' ]]; then
  if [[ -z "${MAVEN_HOME:-}" || ! -r "$MAVEN_HOME/conf/settings.xml" ]]; then
    echo 'MANAGED_MAVEN_USE_SETUP_SETTINGS requires setup-env Maven settings.' >&2
    exit 2
  fi
  cp "$MAVEN_HOME/conf/settings.xml" "$settings"
  echo 'Using setup-env Maven settings'
else
  if [[ -z "${MAVEN_USERNAME:-}" || -z "${MAVEN_PASSWORD:-}" ]]; then
    echo 'Maven credentials missing: use setup-env settings or protected CI secrets.' >&2
    exit 2
  fi
  echo 'Using Maven credentials from protected CI secrets'
  cat > "$settings" <<'EOF'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <servers>
    <server>
      <id>releases</id>
      <username>${env.MAVEN_USERNAME}</username>
      <password>${env.MAVEN_PASSWORD}</password>
    </server>
    <server>
      <id>snapshots</id>
      <username>${env.MAVEN_USERNAME}</username>
      <password>${env.MAVEN_PASSWORD}</password>
    </server>
    <server>
      <id>alibaba</id>
      <username>${env.MAVEN_USERNAME}</username>
      <password>${env.MAVEN_PASSWORD}</password>
    </server>
  </servers>
  <mirrors>
    <mirror>
      <id>alibaba</id>
      <name>Alibaba Maven repository</name>
      <url>https://mvnrepo.alibaba-inc.com/mvn/repository</url>
      <mirrorOf>*</mirrorOf>
    </mirror>
  </mirrors>
</settings>
EOF
fi
chmod 600 "$settings"

if [[ "$publish_mode" == release ]]; then
  current_git_version="$(git --version | cut -d' ' -f3)"
  git_major="${current_git_version%%.*}"
  git_minor_version="${current_git_version#*.}"
  git_minor="${git_minor_version%%.*}"
  if (( git_major < 2 || (git_major == 2 && git_minor < 40) )); then
    for tool in make cc; do
      command -v "$tool" >/dev/null || {
        echo "Missing Git build prerequisite: $tool" >&2
        exit 2
      }
    done
    if ! command -v curl-config >/dev/null; then
      privilege=()
      (( EUID == 0 )) || privilege=(sudo -n)
      package_manager="$(command -v dnf || command -v yum)"
      "${privilege[@]}" "$package_manager" install -y \
        libcurl-devel openssl-devel zlib-devel expat-devel
    fi
    git_archive="$publish_workdir/git-2.48.2.tar.xz"
    curl -fL --retry 3 \
      'https://www.kernel.org/pub/software/scm/git/git-2.48.2.tar.xz' \
      -o "$git_archive"
    echo '30ce5660fc6be0453ab0e15ba3f2b69f2325cde0bb447ad2ee1b559f2999e494  '"$git_archive" |
      sha256sum --check --strict
    tar -xJf "$git_archive" -C "$publish_workdir"
    make -C "$publish_workdir/git-2.48.2" -j8 \
      prefix="$publish_workdir/git-toolchain" \
      NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install
    export PATH="$publish_workdir/git-toolchain/bin:$PATH"
  fi
  git --version

  export COREPACK_NPM_REGISTRY='https://registry.npmmirror.com'
  export npm_config_registry='https://registry.npmmirror.com'
  corepack pnpm install --frozen-lockfile --prefer-offline --reporter=append-only
fi

maven=(mvn -B -ntp -s "$settings" -P alibaba-internal -Dgpg.skip=true)
if [[ "$publish_mode" == snapshot && -n "$source_branch" ]]; then
  maven+=(-DaltDeploymentRepository=snapshots::http://mvnrepo.alibaba-inc.com/mvn/snapshots)
fi
if [[ "$publish_mode" == snapshot ]]; then
  mkdir -p "$pom_backup"
  mapfile -t pom_paths < <(git ls-files \
    'packages/managed-agent-server/pom.xml' \
    'packages/managed-agent-server/**/pom.xml' \
    'packages/sdk-java/qwencode/pom.xml')
  for pom in "${pom_paths[@]}"; do
    cp --parents "$pom" "$pom_backup"
  done
  if [[ -n "${MANAGED_SNAPSHOT_VERSION:-}" ]]; then
    sdk_version="$MANAGED_SNAPSHOT_VERSION"
    managed_version="$sdk_version"
    if [[ "$sdk_version" != *-SNAPSHOT ]]; then
      echo 'MANAGED_SNAPSHOT_VERSION must end with -SNAPSHOT.' >&2
      exit 2
    fi
  else
    sdk_version="${sdk_version%-SNAPSHOT}-SNAPSHOT"
    managed_version="${managed_version%-SNAPSHOT}-SNAPSHOT"
  fi
  versions=(org.codehaus.mojo:versions-maven-plugin:2.18.0)
  "${maven[@]}" -f packages/sdk-java/qwencode/pom.xml \
    "${versions[0]}:set" -DnewVersion="$sdk_version" -DgenerateBackupPoms=false
  "${maven[@]}" -f packages/managed-agent-server/pom.xml \
    "${versions[0]}:set" -DnewVersion="$managed_version" -DgenerateBackupPoms=false
  "${maven[@]}" -f packages/managed-agent-server/pom.xml \
    "${versions[0]}:set-property" -Dproperty=qwencode-sdk.version \
    -DnewVersion="$sdk_version" -DgenerateBackupPoms=false
  python3 - "$sdk_version" "$managed_version" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ns = {"m": "http://maven.apache.org/POM/4.0.0"}
sdk_version, managed_version = sys.argv[1:]
sdk = ET.parse("packages/sdk-java/qwencode/pom.xml").getroot()
assert sdk.findtext("m:version", namespaces=ns) == sdk_version
managed = ET.parse("packages/managed-agent-server/pom.xml").getroot()
assert managed.findtext("m:version", namespaces=ns) == managed_version
assert managed.findtext("m:properties/m:qwencode-sdk.version", namespaces=ns) == sdk_version
for module in managed.findall("m:modules/m:module", ns):
    child = ET.parse(Path("packages/managed-agent-server") / module.text / "pom.xml").getroot()
    assert child.findtext("m:parent/m:version", namespaces=ns) == managed_version, module.text
PY
  maven+=(-DskipTests)
  echo "Publishing SDK $sdk_version and Managed Agent $managed_version from $source_sha"
  "${maven[@]}" -f packages/sdk-java/qwencode/pom.xml \
    clean install org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy
  "${maven[@]}" -f packages/managed-agent-server/pom.xml clean deploy
else
  echo "Publishing SDK $sdk_version and Managed Agent $managed_version from $source_sha"
  "${maven[@]}" -f packages/sdk-java/qwencode/pom.xml clean install
  "${maven[@]}" -f packages/managed-agent-server/pom.xml clean verify
  # The SDK Central extension injects its own publish goal into the deploy lifecycle.
  # Package and invoke the standard deploy goal directly to keep publication internal.
  "${maven[@]}" -DskipTests -f packages/sdk-java/qwencode/pom.xml \
    package org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy
  "${maven[@]}" -DskipTests -f packages/managed-agent-server/pom.xml deploy
fi

consumer="$publish_workdir/consumer"
mkdir -p "$consumer"
python3 - "$PWD" "$consumer/pom.xml" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

namespace = "http://maven.apache.org/POM/4.0.0"
namespaces = {"m": namespace}
ET.register_namespace("", namespace)
root_path = Path(sys.argv[1])
managed = ET.parse(
    root_path / "packages/managed-agent-server/pom.xml"
).getroot()
sdk = ET.parse(root_path / "packages/sdk-java/qwencode/pom.xml").getroot()


def text(element, path):
    value = element.findtext(path, namespaces=namespaces)
    if not value:
        raise ValueError(f"Missing {path}")
    return value.strip()


group = text(managed, "m:groupId")
version = text(managed, "m:version")
modules = [
    module
    for module in managed.findall("m:modules/m:module", namespaces)
    if module.text != "verification"
]
artifacts = [
    (text(sdk, "m:groupId"), text(sdk, "m:artifactId"), text(sdk, "m:version"))
]
for module in modules:
    project = ET.parse(
        root_path / "packages/managed-agent-server" / module.text / "pom.xml"
    ).getroot()
    artifacts.append((group, text(project, "m:artifactId"), version))

project = ET.Element(f"{{{namespace}}}project")
ET.SubElement(project, f"{{{namespace}}}modelVersion").text = "4.0.0"
ET.SubElement(project, f"{{{namespace}}}groupId").text = "com.alibaba.qwen.verify"
ET.SubElement(project, f"{{{namespace}}}artifactId").text = "managed-agent-publish-consumer"
ET.SubElement(project, f"{{{namespace}}}version").text = "1"
dependencies = ET.SubElement(project, f"{{{namespace}}}dependencies")
for artifact_group, artifact_id, artifact_version in artifacts:
    dependency = ET.SubElement(dependencies, f"{{{namespace}}}dependency")
    ET.SubElement(dependency, f"{{{namespace}}}groupId").text = artifact_group
    ET.SubElement(dependency, f"{{{namespace}}}artifactId").text = artifact_id
    ET.SubElement(dependency, f"{{{namespace}}}version").text = artifact_version
repositories = ET.SubElement(project, f"{{{namespace}}}repositories")
repository = ET.SubElement(repositories, f"{{{namespace}}}repository")
ET.SubElement(repository, f"{{{namespace}}}id").text = "alibaba"
ET.SubElement(repository, f"{{{namespace}}}url").text = "https://mvnrepo.alibaba-inc.com/mvn/repository"
for repository_type in ("releases", "snapshots"):
    policy = ET.SubElement(repository, f"{{{namespace}}}{repository_type}")
    ET.SubElement(policy, f"{{{namespace}}}enabled").text = "true"
ET.indent(project)
ET.ElementTree(project).write(sys.argv[2], encoding="UTF-8", xml_declaration=True)
PY

# An empty local repository proves that consumers can resolve every production module.
mvn -B -ntp -s "$settings" -f "$consumer/pom.xml" \
  -Dmaven.repo.local="$publish_workdir/consumer-repository" -U \
  org.apache.maven.plugins:maven-dependency-plugin:3.9.0:resolve

python3 - "$publish_workdir" "$sdk_version" "$managed_version" "$source_sha" \
  "$source_repository" "$source_branch" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

workdir = Path(sys.argv[1])
sdk_version, managed_version, source_sha, source_repository, source_branch = sys.argv[2:]
cache = workdir / "consumer-repository"
repository = "https://mvnrepo.alibaba-inc.com/mvn/repository/com/alibaba"
lines = [
    f"### Maven {'SNAPSHOT' if managed_version.endswith('-SNAPSHOT') else 'release'}",
    "",
    f"Source revision: `{source_sha}`",
]
if source_branch:
    lines.append(f"Source ref: `{source_repository}#{source_branch}`")
lines.append("")
for artifact, version in (("qwen-managed-agent-server", managed_version), ("qwencode-sdk", sdk_version)):
    resolved_version = version
    directory = cache / "com/alibaba" / artifact / version
    if version.endswith("-SNAPSHOT"):
        snapshots = []
        for metadata_path in directory.glob("maven-metadata-*.xml"):
            metadata = ET.parse(metadata_path).getroot()
            timestamp = metadata.findtext("versioning/snapshot/timestamp")
            build = metadata.findtext("versioning/snapshot/buildNumber")
            if timestamp and build:
                snapshots.append((timestamp, build))
        if not snapshots:
            raise ValueError(f"No resolved snapshot metadata for {artifact}")
        timestamp, build = max(snapshots)
        resolved_version = f"{version.removesuffix('-SNAPSHOT')}-{timestamp}-{build}"
    artifact_url = f"{repository}/{artifact}/{version}/{artifact}-{resolved_version}"
    if not (directory / f"{artifact}-{resolved_version}.jar").is_file():
        raise ValueError(f"Resolved JAR missing for {artifact}")
    if version.endswith("-SNAPSHOT"):
        metadata_url = f"{repository}/{artifact}/{version}/maven-metadata.xml"
    else:
        metadata_url = f"{repository}/{artifact}/maven-metadata.xml"
    lines.append(f"- `{artifact}:{resolved_version}` — [JAR]({artifact_url}.jar) · [metadata]({metadata_url})")
(workdir / "maven-links.md").write_text("\n".join(lines) + "\n")
PY
cat "$publish_workdir/maven-links.md"
if [[ -n "${AONE_CI_SUMMARY_MD:-}" ]]; then
  cat "$publish_workdir/maven-links.md" >> "$AONE_CI_SUMMARY_MD"
fi

echo "Remote publish and fresh-cache resolution verified for $source_sha"
