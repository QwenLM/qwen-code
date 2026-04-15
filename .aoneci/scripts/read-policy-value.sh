#!/usr/bin/env bash
# Read a single key from a policy .env file and print its value.
# Usage: read-policy-value.sh <file> <KEY>
set -eu
FILE="${1:?usage: read-policy-value.sh <file> <KEY>}"
KEY="${2:?usage: read-policy-value.sh <file> <KEY>}"
VALUE=$(grep "^${KEY}=" "${FILE}" | head -1 | cut -d= -f2-)
echo "${VALUE}"
