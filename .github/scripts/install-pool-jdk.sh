#!/usr/bin/env bash
# Installs the Temurin JDK a pool job needs without calling api.adoptium.net.
#
# actions/setup-java resolves the requested version through the Adoptium API
# on every run, even when the tool cache already holds it: on the Hangzhou
# hosts that lookup stalls with no timeout, and a job sat in "Set up Java" for
# close to two hours (run 40262799523). This step is the pool's fallback: take
# the cached JDK when a host has one, otherwise fetch the pinned archive from a
# mirror, verify it, and cache it for the next job on that host.
#
# Inputs (environment):
#   JAVA_SPEC  - 11, 17, 21, or 25 (default 21)
#   RUNNER_TEMP, RUNNER_TOOL_CACHE, GITHUB_ENV, GITHUB_PATH - set by the runner
set -uo pipefail

spec="${JAVA_SPEC:-21}"
machine="$(uname -m)"
case "${machine}" in
  aarch64 | arm64) arch='arm64' ;;
  x86_64 | amd64) arch='x64' ;;
  *)
    echo "::error::unsupported architecture ${machine}"
    exit 1
    ;;
esac

# Pinned archive and cache coordinates. `dir` is exactly the version setup-java
# keys its own tool-cache entry by: getToolcacheVersionName() rewrites the first
# '+' of Adoptium's semver to '-' before tc.cacheDir() runs semver.clean(), and
# clean() keeps a prerelease, so the build suffix stays in the directory name.
case "${spec}/${arch}" in
  11/arm64) dir='11.0.32-101'; file='OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32.1_1.tar.gz'; sha='f27033e6f7523c1b0b2565a78e9c0e0abe5596a854ce00ca04ec1b06ece7a935' ;;
  11/x64)   dir='11.0.32-101'; file='OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz';     sha='5c3f68887c325d36d852ba534303e1f5f1f5cae7d6cc1e951d73e0d8e98a058d' ;;
  17/arm64) dir='17.0.20-101'; file='OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz'; sha='457b57af8f9c93ec39080bb8c764f559dc8c89a6da1a39d718a400b7890d3e41' ;;
  17/x64)   dir='17.0.21-9';   file='OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz';       sha='8b9b611d917e3dfd8419d3566b5949226f69b052fed7e109c1368add1dfe8711' ;;
  21/arm64) dir='21.0.13-9.0.LTS'; file='OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.13_9.tar.gz'; sha='e3522e707fc7dbe2a72c30746b1e7068301a0213ecd213d4491f35a14eb55578' ;;
  21/x64)   dir='21.0.13-9.0.LTS'; file='OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz';     sha='d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c' ;;
  25/arm64) dir='25.0.5-8.0.LTS'; file='OpenJDK25U-jdk_aarch64_linux_hotspot_25.0.5_8.tar.gz';   sha='bb5b2ded252f21c6090cf780b0a408ad0d83bbb557e702955643557f13231880' ;;
  *)
    echo "::error::no pinned JDK for spec ${spec} on ${arch}"
    exit 1
    ;;
esac

url="https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${spec}/jdk/${arch/arm64/aarch64}/linux/${file}"
# Read setup-java entries, but never publish into its namespace: setup-java
# does not take our lock and can still be installing when this fallback runs.
shared_tool="${RUNNER_TOOL_CACHE:?}/Java_Temurin-Hotspot_jdk/${dir}/${arch}"
tool="${RUNNER_TOOL_CACHE:?}/qwen-pool-jdk/${dir}/${arch}"
tool_dir="$(dirname -- "${tool}")"

# Pool fallbacks share this lock. A completed entry is immutable; only an
# incomplete entry in our own namespace can be replaced.
exec 9>"${RUNNER_TOOL_CACHE:?}/.jdk-toolcache.lock"
if ! flock --wait 900 9; then
  echo "::error::timed out waiting for the tool-cache lock"
  exit 1
fi
if [[ -d "${shared_tool}" && -f "${shared_tool}.complete" ]]; then
  tool="${shared_tool}"
elif [[ ! -d "${tool}" || ! -f "${tool}.complete" ]]; then
  mkdir -p -- "${tool_dir}" || { echo "::error::cannot create ${tool_dir}"; exit 1; }
  work="$(mktemp -d "${tool_dir}/install.XXXXXX")" || { echo "::error::cannot stage the download"; exit 1; }
  echo "downloading Temurin ${spec} (${arch}) from the mirror"
  if ! curl -fsSL --retry 3 --retry-delay 5 --retry-max-time 300 --max-time 600 "${url}" -o "${work}/jdk.tgz"; then
    echo "::error::could not download ${url}"
    rm -rf "${work}"
    exit 1
  fi
  if ! echo "${sha}  ${work}/jdk.tgz" | sha256sum --check --status; then
    echo "::error::checksum mismatch for ${url}"
    rm -rf "${work}"
    exit 1
  fi
  tar -xzf "${work}/jdk.tgz" -C "${work}" || { echo "::error::cannot unpack ${url}"; rm -rf "${work}"; exit 1; }
  src="$(find "${work}" -maxdepth 1 -mindepth 1 -type d -name 'jdk-*' -print -quit)"
  [[ -n "${src}" ]] || { echo "::error::unexpected archive layout"; rm -rf "${work}"; exit 1; }
  rm -rf -- "${tool}"
  if ! mv -- "${src}" "${tool}"; then
    echo "::error::cannot publish ${tool}"
    rm -rf "${work}"
    exit 1
  fi
  if ! touch "${tool}.complete"; then
    echo "::error::cannot mark ${tool} complete"
    rm -rf "${work}"
    exit 1
  fi
  rm -rf "${work}"
fi
flock -u 9

# setup-java normally writes these two files; MAVEN_ARGS points Maven at them.
settings_dir="${RUNNER_TEMP:?}/setup-java-m2"
mkdir -p "${settings_dir}"
if [[ ! -f "${settings_dir}/settings.xml" ]]; then
  cat > "${settings_dir}/settings.xml" <<XML
<settings>
  <servers>
    <server>
      <id>github</id>
      <username>\${env.GITHUB_ACTOR}</username>
      <password>\${env.GITHUB_TOKEN}</password>
    </server>
  </servers>
</settings>
XML
fi
if [[ ! -f "${settings_dir}/toolchains.xml" ]]; then
  cat > "${settings_dir}/toolchains.xml" <<XML
<toolchains>
  <toolchain>
    <type>jdk</type>
    <provides>
      <version>${spec}</version>
      <vendor>temurin</vendor>
    </provides>
    <configuration>
      <jdkHome>${tool}</jdkHome>
    </configuration>
  </toolchain>
</toolchains>
XML
fi

echo "JAVA_HOME=${tool}" >> "${GITHUB_ENV:?}"
echo "${tool}/bin" >> "${GITHUB_PATH:?}"
echo "using cached Temurin ${spec} at ${tool}"
