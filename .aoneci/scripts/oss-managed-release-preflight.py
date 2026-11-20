#!/usr/bin/env python3
"""Check that one known CI OSS credential pair can read the Managed release bucket."""
import base64
import hashlib
import hmac
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BUCKET = "dataworks-upload-and-download-inner-pre"
HOST = f"{BUCKET}.oss-cn-zhangjiakou.aliyuncs.com"
OBJECT = sys.argv[1]
CANDIDATES = [
    ("BASE_SOURCE", "BASE_SOURCE_OSS_ACCESS_KEY_ID", "BASE_SOURCE_OSS_ACCESS_KEY_SECRET"),
    ("DWCODE", "DWCODE_OSS_ACCESS_KEY_ID", "DWCODE_OSS_ACCESS_KEY_SECRET"),
    ("DW_NOTEBOOK", "DW_NOTEBOOK_OSS_ACCESS_KEY_ID", "DW_NOTEBOOK_OSS_ACCESS_KEY_SECRET"),
]


def zero_trust_credentials():
    if not os.environ.get("BOOTSTRAP_TOKEN"):
        return None
    command = [
        "bash", "-c",
        ". .aoneci/scripts/resolve-oss-sts.sh public",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return None
    values = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("=")
        values[key] = value.strip().strip("'")
    access_key = values.get("OSS_ACCESS_KEY_ID")
    secret = values.get("OSS_ACCESS_KEY_SECRET")
    token = values.get("OSS_SECURITY_TOKEN")
    if access_key and secret and token:
        return access_key, secret, token
    return None


def probe(name, key_name, secret_name, access_key=None, secret=None, security_token=None):
    if access_key is None:
        access_key = os.environ.get(key_name, "")
        secret = os.environ.get(secret_name, "")
    if not access_key or not secret:
        return f"{name}: missing"
    expires = str(int(time.time()) + 300)
    canonical_oss = ""
    headers = {}
    if security_token:
        headers["x-oss-security-token"] = security_token
        canonical_oss = f"x-oss-security-token:{security_token}\n"
    canonical = f"HEAD\n\n\n{expires}\n{canonical_oss}/{BUCKET}/{OBJECT}"
    signature = base64.b64encode(
        hmac.new(secret.encode(), canonical.encode(), hashlib.sha1).digest()
    ).decode()
    query = urllib.parse.urlencode({
        "OSSAccessKeyId": access_key,
        "Expires": expires,
        "Signature": signature,
    })
    request = urllib.request.Request(f"https://{HOST}/{OBJECT}?{query}", method="HEAD", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return f"{name}: HTTP {response.status}, bytes={response.headers.get('Content-Length')}"
    except urllib.error.HTTPError as error:
        return f"{name}: HTTP {error.code}"


for candidate in CANDIDATES:
    print(probe(*candidate))
zero_trust = zero_trust_credentials()
if zero_trust:
    print(probe("ZERO_TRUST", None, None, *zero_trust))
else:
    print("ZERO_TRUST: unavailable")
