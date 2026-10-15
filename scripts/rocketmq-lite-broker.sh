#!/usr/bin/env bash
# @license
# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
#
# A single-node Apache RocketMQ cluster (NameServer + broker + gRPC proxy)
# that serves LiteTopics, for the Managed Agent EventTransport broker gates
# (design 2026-10-12-managed-agent-event-transport-mq2, phase MQ2d). Used by
# the SDK Java workflow and runnable locally on Linux or macOS.
#
#   scripts/rocketmq-lite-broker.sh start   download (cached), configure, boot,
#                                           create the LITE topic and groups,
#                                           write $RMQ_WORK_DIR/broker.env;
#                                           a start that fails part way stops
#                                           what it launched
#   scripts/rocketmq-lite-broker.sh stop    stop every process it started
#   scripts/rocketmq-lite-broker.sh admin … run mqadmin against the NameServer
#
# The broker needs enableLmq, enableMultiDispatch and the RocksDB store to
# serve LiteTopics; the topic is created with message.type=LITE and every
# consumer group as a LITE group bound to it, because subscribeLite rejects
# an auto-created (regular) group. mqadmin creates nothing, printing only its
# usage, unless a cluster (-c) or broker (-b) is named — and it can exit 0
# when it fails, so this script reads success from its output.
#
# Exposure: the NameServer and the broker's main port bind 127.0.0.1, but the
# proxy (gRPC and remoting) and the broker's HA port (listenPort + 1) have no
# bind option and listen on every interface, unauthenticated. CI runners are
# ephemeral; on a workstation, run it only on a trusted network or behind a
# host firewall, and stop it when done.
#
# On macOS the RocketMQ launch scripts create a RAM disk at /Volumes/RAMDisk
# for GC logs; stop ejects it when this script's start created it, unless
# another instance still has files open on it. The broker logs themselves
# land in $RMQ_WORK_DIR/home/logs/rocketmqlogs/.
set -euo pipefail

RMQ_VERSION="${RMQ_VERSION:-5.5.1}"
RMQ_WORK_DIR="${RMQ_WORK_DIR:-${TMPDIR:-/tmp}/qwen-rocketmq-lite}"
RMQ_CACHE_DIR="${RMQ_CACHE_DIR:-${RMQ_WORK_DIR}/dist}"
RMQ_NAMESRV_PORT="${RMQ_NAMESRV_PORT:-19876}"
RMQ_BROKER_PORT="${RMQ_BROKER_PORT:-20911}"
RMQ_PROXY_GRPC_PORT="${RMQ_PROXY_GRPC_PORT:-18081}"
RMQ_PROXY_REMOTING_PORT="${RMQ_PROXY_REMOTING_PORT:-18080}"
RMQ_HEAP="${RMQ_HEAP:-512m}"
RMQ_TOPIC="${RMQ_TOPIC:-qwen-managed-events}"
# The groups the server binds (capability probe, wake bootstrap, owner) plus
# any the gates add.
RMQ_GROUPS="${RMQ_GROUPS:-qwen-managed-journal-capability-probe qwen-managed-wake-bootstrap qwen-managed-session-owner}"
RMQ_EXTRA_GROUPS="${RMQ_EXTRA_GROUPS:-}"
# Optional: a NORMAL (not LITE) topic and the LITE groups bound to it, so the
# gates can prove a misconfigured topic fails startup.
RMQ_NORMAL_TOPIC="${RMQ_NORMAL_TOPIC:-}"
RMQ_NORMAL_GROUPS="${RMQ_NORMAL_GROUPS:-}"
# The broker runs on the JDK 17 the 5.5.1 staging verification used; prefer
# the runner's 17 when it provides one.
RMQ_JAVA_HOME="${RMQ_JAVA_HOME:-${JAVA_HOME_17_X64:-${JAVA_HOME:-}}}"

DIST_NAME="rocketmq-all-${RMQ_VERSION}-bin-release"
# The SHA-512 Apache publishes for the 5.5.1 binary release, pinned so a
# cached download is checked against a value that did not come from the same
# cache. Another version is checked against its published .sha512 file.
PINNED_SHA512_5_5_1="21555d9bd79792ac89f246566f19f58e300784c59b96289fd0c74db14787861081fb60ebb95cf541bf20a3e508bf3b70feb9596ea3ba6dc5dc88fa6081f00577"
CLUSTER="DefaultCluster"

log() { printf '[rocketmq-lite] %s\n' "$*" >&2; }

die() {
  log "$*"
  exit 1
}

# The components this start launched, newest first, and whether the RAM disk
# was absent before it: a start that fails part way stops exactly these on
# exit, and never a process that was running before it.
STARTED=""
RAMDISK_BEFORE=1

java_env() {
  [ -n "${RMQ_JAVA_HOME}" ] || die "set RMQ_JAVA_HOME (or JAVA_HOME) to a JDK 17"
  export JAVA_HOME="${RMQ_JAVA_HOME}"
  export PATH="${JAVA_HOME}/bin:${PATH}"
  export ROCKETMQ_HOME="${RMQ_WORK_DIR}/${DIST_NAME}"
  # user.home keeps the client and server state inside the work dir.
  export JAVA_OPT_EXT="-Xms${RMQ_HEAP} -Xmx${RMQ_HEAP} -Duser.home=${RMQ_WORK_DIR}/home"
}

download() {
  mkdir -p "${RMQ_CACHE_DIR}"
  local zip="${RMQ_CACHE_DIR}/${DIST_NAME}.zip"
  local sum="${RMQ_CACHE_DIR}/${DIST_NAME}.zip.sha512"
  local base
  if [ ! -s "${zip}" ] || [ ! -s "${sum}" ]; then
    for base in "https://dlcdn.apache.org/rocketmq/${RMQ_VERSION}" \
      "https://archive.apache.org/dist/rocketmq/${RMQ_VERSION}"; do
      if curl -fsSL --retry 3 -o "${zip}.part" "${base}/${DIST_NAME}.zip" &&
        curl -fsSL --retry 3 -o "${sum}" "${base}/${DIST_NAME}.zip.sha512"; then
        mv "${zip}.part" "${zip}"
        break
      fi
      rm -f "${zip}.part" "${sum}"
    done
  fi
  [ -s "${zip}" ] || die "could not download ${DIST_NAME}.zip"
  # Apache publishes the digest in `gpg --print-md` form ("name: HEX HEX …"
  # across lines, upper case); sha512sum form is "hex  name". Accept both.
  local expected actual
  if [ "${RMQ_VERSION}" = "5.5.1" ]; then
    expected="${PINNED_SHA512_5_5_1}"
  elif grep -q ':' "${sum}"; then
    expected="$(sed 's/^[^:]*://' "${sum}" | tr -d ' \t\r\n' | tr 'A-F' 'a-f')"
  else
    expected="$(awk 'NR == 1 {print tolower($1)}' "${sum}")"
  fi
  if command -v sha512sum > /dev/null 2>&1; then
    actual="$(sha512sum "${zip}" | awk '{print $1}')"
  else
    actual="$(shasum -a 512 "${zip}" | awk '{print $1}')"
  fi
  [ "${expected}" = "${actual}" ] || die "${DIST_NAME}.zip failed its SHA-512 check"
  rm -rf "${RMQ_WORK_DIR:?}/${DIST_NAME}"
  unzip -q "${zip}" -d "${RMQ_WORK_DIR}"
}

write_config() {
  mkdir -p "${RMQ_WORK_DIR}/conf" "${RMQ_WORK_DIR}/logs" "${RMQ_WORK_DIR}/store" "${RMQ_WORK_DIR}/home"
  cat > "${RMQ_WORK_DIR}/conf/namesrv.conf" << EOF
listenPort=${RMQ_NAMESRV_PORT}
bindAddress=127.0.0.1
EOF
  cat > "${RMQ_WORK_DIR}/conf/broker.conf" << EOF
brokerClusterName=${CLUSTER}
brokerName=broker-a
brokerId=0
namesrvAddr=127.0.0.1:${RMQ_NAMESRV_PORT}
listenPort=${RMQ_BROKER_PORT}
brokerIP1=127.0.0.1
bindAddress=127.0.0.1
storePathRootDir=${RMQ_WORK_DIR}/store
storePathCommitLog=${RMQ_WORK_DIR}/store/commitlog
brokerRole=ASYNC_MASTER
flushDiskType=ASYNC_FLUSH
enableLmq=true
enableMultiDispatch=true
storeType=defaultRocksDB
diskMaxUsedSpaceRatio=98
EOF
  cat > "${RMQ_WORK_DIR}/conf/proxy.json" << EOF
{
  "rocketMQClusterName": "${CLUSTER}",
  "namesrvAddr": "127.0.0.1:${RMQ_NAMESRV_PORT}",
  "grpcServerPort": ${RMQ_PROXY_GRPC_PORT},
  "remotingListenPort": ${RMQ_PROXY_REMOTING_PORT},
  "proxyMode": "cluster"
}
EOF
}

listener_pid() {
  if command -v lsof > /dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2> /dev/null | head -1 || true
  else
    ss -ltnpH "sport = :$1" 2> /dev/null |
      sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true
  fi
}

process_group() {
  ps -o pgid= -p "$1" 2> /dev/null | tr -d ' ' || true
}

# Starts one component and waits for its port. The launch script runs the
# JVM as its grandchild, through a second shell, so the launch runs in a
# process group of its own (job control) that the shells and the JVM inherit:
# the recorded PID is the port's listener in that group, and a failed launch
# stops that group and nothing outside it. The port must be free beforehand;
# a listener outside the group belongs to someone else and is never touched.
# Each pid file also records its port, so stop needs no port settings.
launch() {
  local name="$1" port="$2" ready="$3"
  shift 3
  if [ -n "$(listener_pid "${port}")" ]; then
    log "port ${port} for the ${name} is already in use"
    return 2
  fi
  set -m
  nohup "$@" > "${RMQ_WORK_DIR}/logs/${name}.out" 2>&1 &
  local launcher=$! listener status=1
  set +m
  for _ in $(seq 1 120); do
    listener="$(listener_pid "${port}")"
    if [ -n "${listener}" ]; then
      if [ "$(process_group "${listener}")" != "${launcher}" ]; then
        log "port ${port} for the ${name} was taken by another process"
        status=2
        break
      fi
      if grep -q "${ready}" "${RMQ_WORK_DIR}/logs/${name}.out" 2> /dev/null; then
        echo "${listener} ${port}" > "${RMQ_WORK_DIR}/${name}.pid"
        STARTED="${name} ${STARTED}"
        log "${name} is up on 127.0.0.1:${port}"
        return 0
      fi
    fi
    # The launch script exits with its JVM: stop waiting on a dead start.
    if ! kill -0 "${launcher}" 2> /dev/null; then
      break
    fi
    sleep 1
  done
  tail -20 "${RMQ_WORK_DIR}/logs/${name}.out" >&2 || true
  # A start that hung must not hold the port for the retry or the next run.
  kill -- -"${launcher}" 2> /dev/null || true
  for _ in $(seq 1 30); do
    kill -0 -- -"${launcher}" 2> /dev/null || break
    sleep 1
  done
  kill -9 -- -"${launcher}" 2> /dev/null || true
  return "${status}"
}

# mqadmin can exit 0 when it creates nothing, so a step succeeds only when
# its output reports success and echoes the expected configuration.
provision() {
  local what="$1" expect="$2" output
  shift 2
  output="$(admin "$@" 2>&1)" || true
  if ! grep -q " success\." <<< "${output}" ||
    ! grep -qF -- "${expect}" <<< "${output}"; then
    printf '%s\n' "${output}" | tail -20 >&2
    die "could not create ${what}"
  fi
  log "created ${what}"
}

admin() {
  java_env
  "${ROCKETMQ_HOME}/bin/mqadmin" "$@" -n "127.0.0.1:${RMQ_NAMESRV_PORT}"
}

# Runs on exit while start is in flight: a failed start leaves nothing it
# launched behind, so a retry finds its ports free.
roll_back_start() {
  local status=$?
  [ "${status}" -ne 0 ] || return 0
  if [ -n "${STARTED}" ]; then
    log "start failed; stopping what it started: ${STARTED}"
    # shellcheck disable=SC2086 # component names, split on purpose
    stop_components ${STARTED}
  fi
  if [ "${RAMDISK_BEFORE}" -eq 0 ] && [ -d /Volumes/RAMDisk ]; then
    diskutil eject /Volumes/RAMDisk > /dev/null 2>&1 ||
      log "/Volumes/RAMDisk is still in use; left mounted"
  fi
}

start() {
  java_env
  trap roll_back_start EXIT
  if [ "$(uname -s)" = "Darwin" ] && [ ! -d /Volumes/RAMDisk ]; then
    RAMDISK_BEFORE=0
  fi
  [ -x "${ROCKETMQ_HOME}/bin/mqbroker" ] || download
  java_env
  write_config
  launch namesrv "${RMQ_NAMESRV_PORT}" "boot success" \
    "${ROCKETMQ_HOME}/bin/mqnamesrv" -c "${RMQ_WORK_DIR}/conf/namesrv.conf" ||
    die "the NameServer did not start"
  launch broker "${RMQ_BROKER_PORT}" "boot success" \
    "${ROCKETMQ_HOME}/bin/mqbroker" -c "${RMQ_WORK_DIR}/conf/broker.conf" ||
    die "the broker did not start"
  # The proxy's first start can fail creating a system topic before the
  # broker has registered with the NameServer; a retry succeeds.
  local attempt started
  for attempt in 1 2 3; do
    started=0
    launch proxy "${RMQ_PROXY_GRPC_PORT}" "startup successfully" \
      "${ROCKETMQ_HOME}/bin/mqproxy" -pc "${RMQ_WORK_DIR}/conf/proxy.json" ||
      started=$?
    [ "${started}" -ne 0 ] || break
    [ "${started}" -ne 2 ] || die "the proxy port is already in use"
    [ "${attempt}" -lt 3 ] || die "the proxy did not start"
    log "proxy start ${attempt} failed; retrying"
    sleep 5
  done
  provision "LITE topic ${RMQ_TOPIC}" "+message.type=LITE" \
    updateTopic -c "${CLUSTER}" -t "${RMQ_TOPIC}" -a +message.type=LITE
  local group
  for group in ${RMQ_GROUPS} ${RMQ_EXTRA_GROUPS}; do
    provision "LITE group ${group}" "+lite.bind.topic=${RMQ_TOPIC}" \
      updateSubGroup -c "${CLUSTER}" -g "${group}" -o true \
      --attributes "+lite.bind.topic=${RMQ_TOPIC}"
  done
  if [ -n "${RMQ_NORMAL_TOPIC}" ]; then
    provision "NORMAL topic ${RMQ_NORMAL_TOPIC}" "topicName=${RMQ_NORMAL_TOPIC}" \
      updateTopic -c "${CLUSTER}" -t "${RMQ_NORMAL_TOPIC}"
    for group in ${RMQ_NORMAL_GROUPS}; do
      provision "LITE group ${group}" "+lite.bind.topic=${RMQ_NORMAL_TOPIC}" \
        updateSubGroup -c "${CLUSTER}" -g "${group}" -o true \
        --attributes "+lite.bind.topic=${RMQ_NORMAL_TOPIC}"
    done
  fi
  cat > "${RMQ_WORK_DIR}/broker.env" << EOF
RMQ_ENDPOINTS=127.0.0.1:${RMQ_PROXY_GRPC_PORT}
RMQ_NAMESRV=127.0.0.1:${RMQ_NAMESRV_PORT}
RMQ_TOPIC=${RMQ_TOPIC}
RMQ_NORMAL_TOPIC=${RMQ_NORMAL_TOPIC}
EOF
  if [ "${RAMDISK_BEFORE}" -eq 0 ] && [ -d /Volumes/RAMDisk ]; then
    touch "${RMQ_WORK_DIR}/created-ramdisk"
  fi
  trap - EXIT
  log "ready: endpoints 127.0.0.1:${RMQ_PROXY_GRPC_PORT}, topic ${RMQ_TOPIC}"
  log "note: the proxy (${RMQ_PROXY_GRPC_PORT}, ${RMQ_PROXY_REMOTING_PORT}) and the broker HA port listen on every interface"
}

# Stops the named components through their pid files.
stop_components() {
  local name pid port
  for name in "$@"; do
    [ -s "${RMQ_WORK_DIR}/${name}.pid" ] || continue
    read -r pid port < "${RMQ_WORK_DIR}/${name}.pid"
    # A stale file may name a PID the system has since reused: stop only the
    # process that still holds the port this component was started on.
    if [ -z "${port}" ] || [ "$(listener_pid "${port}")" != "${pid}" ]; then
      log "${name}: PID ${pid} no longer holds port ${port:-?}; not killing it"
      rm -f "${RMQ_WORK_DIR}/${name}.pid"
      continue
    fi
    kill "${pid}" 2> /dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "${pid}" 2> /dev/null || break
      sleep 1
    done
    kill -9 "${pid}" 2> /dev/null || true
    rm -f "${RMQ_WORK_DIR}/${name}.pid"
  done
}

eject_ramdisk() {
  if [ -f "${RMQ_WORK_DIR}/created-ramdisk" ] && [ -d /Volumes/RAMDisk ]; then
    if diskutil eject /Volumes/RAMDisk > /dev/null 2>&1; then
      rm -f "${RMQ_WORK_DIR}/created-ramdisk"
    else
      log "/Volumes/RAMDisk is still in use; left mounted"
    fi
  fi
}

stop() {
  stop_components proxy broker namesrv
  eject_ramdisk
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  admin)
    shift
    admin "$@"
    ;;
  *)
    echo "usage: $0 start|stop|admin <mqadmin args>" >&2
    exit 2
    ;;
esac
