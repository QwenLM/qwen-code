#!/usr/bin/env bash
# Points the pool's Maven runs at a domestic mirror of Central.
#
# The pool fetches from one egress with dozens of jobs at a time, and Central
# answers 429 (or truncates the transfer) once that egress passes its rate
# limit; a cold job pulls several hundred megabytes of dependencies.
# actions/setup-java writes the settings file the Maven steps already pass with
# --settings, and it contains servers but no mirrors, so this replaces it with
# the same server entry plus a central mirror.
set -uo pipefail

settings="${RUNNER_TEMP:?}/setup-java-m2/settings.xml"
mirror="${MAVEN_MIRROR_URL:-https://maven.aliyun.com/repository/public}"

mkdir -p -- "$(dirname -- "${settings}")" || {
  echo "::error::cannot create $(dirname -- "${settings}")"
  exit 1
}

cat > "${settings}" <<XML || { echo "::error::cannot write ${settings}"; exit 1; }
<settings>
  <mirrors>
    <mirror>
      <id>pool-central-mirror</id>
      <mirrorOf>central</mirrorOf>
      <url>${mirror}</url>
    </mirror>
  </mirrors>
  <servers>
    <server>
      <id>github</id>
      <username>\${env.GITHUB_ACTOR}</username>
      <password>\${env.GITHUB_TOKEN}</password>
    </server>
  </servers>
</settings>
XML

echo "Maven settings ${settings} now mirror central through ${mirror}"
