#!/usr/bin/env python3
"""Verify one Managed release, or publish it to Maven and OSS.

Consumes the four CI artifacts produced by native_release, runtime_release and the
Worker/Harness image jobs:
  native  artifact: <dir>/.../artifact/qwen-managed-agent-server-<releaseId>.jar/.pom,
                    <dir>/.../artifact/sdk/qwencode-sdk-<sdkVersion>.jar/.pom,
                    PROVENANCE.json, assembly-validation.json
  runtime artifact: <dir>/.../qwen-runtime-<preview>.tar.gz, PROVENANCE.json,
                    runtime-manifest.json
  image artifacts:  worker-image.json and harness-image.json

Ordering guarantees:
  1. Local verification: releaseId/sourceSha match, native mode matches the declared gate
     (package or verify), both image records describe this exact runtime, and every SHA256
     in both PROVENANCE documents and assembly-validation.json matches the bytes on disk.
  2. Credential gate: Maven credentials must exist. OSS candidates are optional;
     when no OSS credential can HEAD the release prefix, the runtime archive and
     manifest are uploaded as CI artifacts instead of OSS objects, and the run
     still publishes Maven coordinates and image digests.
  3. Every OSS PUT sends x-oss-forbid-overwrite; every written object is read back
     and its SHA256 re-verified. SDK and MAS are both published to Maven. The release
     manifest, including immutable Worker/Harness image digests, is written last as
     the commit marker for the release.

With --bundle-out, the script stops after verification and writes a release bundle
manifest. With --published-manifest-out, it also records the final post-publication
manifest while uploading the JARs and image digests.

Credentials are read from the environment and are never printed, never put on a
command line, and never embedded in an error message.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.sax.saxutils
from pathlib import Path

BUCKET = "dataworks-upload-and-download-inner-pre"
OSS_HOST = f"{BUCKET}.oss-cn-zhangjiakou.aliyuncs.com"
MAVEN_REPO_URL = "https://mvnrepo.alibaba-inc.com/mvn/repository"
MAVEN_REPO_ID = "alibaba-releases"
WORKER_REPOSITORY = "hub.docker.alibaba-inc.com/aone-base-global/data-agent-worker"
HARNESS_REPOSITORY = "hub.docker.alibaba-inc.com/aone-base-global/data-agent-harness"
OSS_CANDIDATES = [
    ("BASE_SOURCE", "BASE_SOURCE_OSS_ACCESS_KEY_ID", "BASE_SOURCE_OSS_ACCESS_KEY_SECRET"),
    ("DWCODE", "DWCODE_OSS_ACCESS_KEY_ID", "DWCODE_OSS_ACCESS_KEY_SECRET"),
    ("DW_NOTEBOOK", "DW_NOTEBOOK_OSS_ACCESS_KEY_ID", "DW_NOTEBOOK_OSS_ACCESS_KEY_SECRET"),
]


def fail(message):
    print(f"publish-managed-release: {message}", file=sys.stderr)
    sys.exit(1)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(label, path, expected):
    if not path.is_file():
        fail(f"{label} missing: {path}")
    if not expected:
        fail(f"{label} has no expected sha256 in provenance")
    actual = sha256(path)
    if actual != expected:
        fail(f"{label} sha256 mismatch: expected {expected}, got {actual}")
    return actual


def locate(root, pattern, label):
    matches = sorted(root.glob(pattern))
    if len(matches) != 1:
        fail(f"{label}: expected exactly one {pattern} under {root}, found {len(matches)}")
    return matches[0]


def verify_inputs(native_dir, runtime_dir, release_id, source_sha):
    native_prov_path = locate(native_dir, "**/artifact/PROVENANCE.json", "native PROVENANCE")
    native_artifact = native_prov_path.parent
    native_prov = json.loads(native_prov_path.read_text())
    if native_prov.get("mode") not in ("package", "verify"):
        fail("native provenance mode must be package or verify before publication")
    runtime_prov_path = locate(runtime_dir, "**/PROVENANCE.json", "runtime PROVENANCE")
    runtime_root = runtime_prov_path.parent
    runtime_prov = json.loads(runtime_prov_path.read_text())

    if native_prov.get("releaseId") != release_id:
        fail(f"native provenance releaseId {native_prov.get('releaseId')!r} != {release_id!r}")
    if runtime_prov.get("preview") != release_id:
        fail(f"runtime provenance preview {runtime_prov.get('preview')!r} != {release_id!r}")
    for label, prov in (("native", native_prov), ("runtime", runtime_prov)):
        if prov.get("sourceRevision") != source_sha:
            fail(f"{label} provenance sourceRevision {prov.get('sourceRevision')!r} != {source_sha!r}")

    assembly = json.loads((native_artifact / "assembly-validation.json").read_text())
    if assembly.get("sourceRevision") != source_sha:
        fail("assembly-validation sourceRevision does not match sourceSha")
    for key in ("jarSha256", "pomSha256", "sdkJarSha256", "sdkPomSha256"):
        if assembly.get(key) != native_prov.get(key):
            fail(f"native provenance {key} disagrees with assembly-validation.json")

    sdk_version = native_prov.get("sdkVersion")
    if not sdk_version:
        fail("native provenance is missing sdkVersion")
    server_jar = native_artifact / f"qwen-managed-agent-server-{release_id}.jar"
    server_pom = native_artifact / f"qwen-managed-agent-server-{release_id}.pom"
    sdk_jar = native_artifact / "sdk" / f"qwencode-sdk-{sdk_version}.jar"
    sdk_pom = native_artifact / "sdk" / f"qwencode-sdk-{sdk_version}.pom"
    runtime_tar = runtime_root / f"qwen-runtime-{release_id}.tar.gz"

    hashes = {
        "serverJarSha256": require_hash("server jar", server_jar, native_prov.get("jarSha256")),
        "serverPomSha256": require_hash("server pom", server_pom, native_prov.get("pomSha256")),
        "sdkJarSha256": require_hash("sdk jar", sdk_jar, native_prov.get("sdkJarSha256")),
        "sdkPomSha256": require_hash("sdk pom", sdk_pom, native_prov.get("sdkPomSha256")),
        "runtimeTarSha256": require_hash("runtime archive", runtime_tar, runtime_prov.get("sha256")),
    }
    coordinate = native_prov.get("coordinate")
    sdk_coordinate = assembly.get("sdk")
    if not coordinate or not sdk_coordinate:
        fail("native provenance is missing Maven coordinates")
    if not (runtime_root / "runtime-manifest.json").is_file():
        fail("runtime-manifest.json missing from runtime artifact")
    return {
        "coordinate": coordinate,
        "sdkCoordinate": sdk_coordinate,
        "nativeMode": native_prov.get("mode"),
        "sdkVersion": sdk_version,
        "serverJar": server_jar,
        "serverPom": server_pom,
        "sdkJar": sdk_jar,
        "sdkPom": sdk_pom,
        "runtimeTar": runtime_tar,
        "runtimeProvenance": runtime_prov,
        "hashes": hashes,
    }


def verify_image_record(image_dir, producer, repository, release_id, runtime_prov):
    record_path = locate(image_dir, f"**/{producer}-image.json", f"{producer} image record")
    record = json.loads(record_path.read_text())
    digest = record.get("digest", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        fail(f"{producer} image record has an invalid digest")
    tag = f"{producer}-{release_id}"
    image = f"{repository}:{tag}"
    if record.get("producer") != producer:
        fail(f"{producer} image record has producer {record.get('producer')!r}")
    if record.get("image") != image:
        fail(f"{producer} image record has unexpected image {record.get('image')!r}")
    if record.get("immutableImage") != f"{image}@{digest}":
        fail(f"{producer} image record has an inconsistent immutable image")
    if record.get("runtime") != runtime_prov:
        fail(f"{producer} image record is not tied to this runtime provenance")
    return {
        "repository": repository,
        "tag": tag,
        "digest": digest,
        "immutableImage": f"{image}@{digest}",
    }


# --- OSS (V1 signed requests, stdlib only) -------------------------------------

def oss_signed_request(object_key, access_key, secret, method, extra_headers=None,
                       security_token=None):
    """Return (url, headers) signed with the Authorization header approach.
    Query-string presigned PUTs get SignatureDoesNotMatch on this bucket."""
    date = email.utils.formatdate(time.time(), usegmt=True)
    signed_headers = dict(extra_headers or {})
    if security_token:
        signed_headers["x-oss-security-token"] = security_token
    canonical_oss = ""
    if signed_headers:
        canonical_oss = "".join(
            f"{key.lower()}:{value}\n" for key, value in sorted(signed_headers.items())
        )
    string_to_sign = f"{method}\n\n\n{date}\n{canonical_oss}/{BUCKET}/{object_key}"
    signature = base64.b64encode(
        hmac.new(secret.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    url = f"https://{BUCKET}.{OSS_HOST}/{urllib.parse.quote(object_key)}"
    headers = dict(signed_headers)
    headers["Date"] = date
    headers["Authorization"] = f"OSS {access_key}:{signature}"
    return url, headers


def oss_head(object_key, access_key, secret, security_token=None):
    extra = {"x-oss-security-token": security_token} if security_token else None
    url, headers = oss_signed_request(object_key, access_key, secret, "HEAD",
                                      extra_headers=extra, security_token=None)
    request = urllib.request.Request(
        url, method="HEAD", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def zero_trust_credentials(repo):
    if not os.environ.get("BOOTSTRAP_TOKEN"):
        return None
    script = repo / ".aoneci" / "scripts" / "resolve-oss-sts.sh"
    if not script.is_file():
        return None
    result = subprocess.run(
        ["bash", "-c", f". '{script}' public"],
        capture_output=True, text=True, timeout=120, cwd=repo,
    )
    if result.returncode != 0:
        return None
    values = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("=")
        values[key] = value.strip().strip("'")
    access_key = values.get("OSS_ACCESS_KEY_ID")
    secret = values.get("OSS_ACCESS_KEY_SECRET")
    token = values.get("OSS_SECURITY_TOKEN")
    if access_key and secret and token:
        return "ZERO_TRUST", access_key, secret, token
    return None


def resolve_oss_credentials(repo, probe_key):
    """Return (name, ak, sk, security token) of the first candidate that can HEAD the release prefix."""
    candidates = []
    for name, key_env, secret_env in OSS_CANDIDATES:
        access_key = os.environ.get(key_env, "")
        secret = os.environ.get(secret_env, "")
        if access_key and secret:
            candidates.append((name, access_key, secret, None))
    zero_trust = zero_trust_credentials(repo)
    if zero_trust:
        candidates.append(zero_trust)
    if not candidates:
        fail("no OSS credentials found: set DWCODE_OSS_ACCESS_KEY_ID/SECRET or "
             "DW_NOTEBOOK_OSS_ACCESS_KEY_ID/SECRET or BOOTSTRAP_TOKEN")
    errors = []
    for name, access_key, secret, security_token in candidates:
        status = oss_head(probe_key, access_key, secret, security_token)
        if status == 200:
            fail(f"OSS object already exists, refusing to overwrite: {probe_key}")
        if status == 404:
            return name, access_key, secret, security_token
        errors.append(f"{name}: HTTP {status}")
    fail("no OSS credential can read the release bucket: " + "; ".join(errors))


def oss_put(object_key, path, access_key, secret, security_token=None):
    url, headers = oss_signed_request(
        object_key, access_key, secret, "PUT",
        extra_headers={"x-oss-forbid-overwrite": "true"},
        security_token=security_token)
    request = urllib.request.Request(url, data=path.read_bytes(), method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            if response.status != 200:
                fail(f"OSS PUT {object_key} returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        # The OSS error body may echo the AccessId; report only the status code.
        fail(f"OSS PUT {object_key} failed: HTTP {error.code}")


def oss_verify(object_key, expected_sha, access_key, secret, security_token=None):
    url, headers = oss_signed_request(
        object_key, access_key, secret, "GET",
        security_token=security_token)
    request = urllib.request.Request(
        url, headers=headers)
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            for chunk in iter(lambda: response.read(1 << 20), b""):
                digest.update(chunk)
    except urllib.error.HTTPError as error:
        fail(f"OSS readback {object_key} failed: HTTP {error.code}")
    if digest.hexdigest() != expected_sha:
        fail(f"OSS readback {object_key} sha256 mismatch")
    print(f"published oss://{BUCKET}/{object_key} sha256={expected_sha}")


# --- Maven ---------------------------------------------------------------------

def require_maven_credentials():
    username = os.environ.get("MAVEN_USERNAME", "")
    password = os.environ.get("MAVEN_PASSWORD", "")
    if not username or not password:
        fail("Maven credentials missing: set MAVEN_USERNAME and MAVEN_PASSWORD")


def artifact_url(coordinate, extension, base_url=MAVEN_REPO_URL):
    group_id, artifact_id, version = coordinate.split(":")
    group_path = group_id.replace(".", "/")
    return f"{base_url}/{group_path}/{artifact_id}/{version}/{artifact_id}-{version}.{extension}"


def maven_headers(username, password):
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": "Basic " + token}


def maven_probe(jar_url, pom_url, username, password):
    headers = maven_headers(username, password)
    statuses = []
    for url in (jar_url, pom_url):
        request = urllib.request.Request(url, method="HEAD", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                statuses.append(response.status)
        except urllib.error.HTTPError as error:
            statuses.append(error.code)
    if 200 in statuses:
        fail("Maven coordinate already exists, refusing to overwrite")
    if any(status != 404 for status in statuses):
        fail("cannot inspect Maven coordinate before deploy: HTTP " + ",".join(map(str, statuses)))


def maven_verify(url, expected_sha, username, password, wait_seconds=0):
    deadline = time.monotonic() + wait_seconds
    while True:
        request = urllib.request.Request(url, headers=maven_headers(username, password))
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                for chunk in iter(lambda: response.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected_sha:
                fail("Maven readback sha256 mismatch")
            return
        except urllib.error.HTTPError as error:
            if error.code == 404 and time.monotonic() < deadline:
                time.sleep(2)
                continue
            fail(f"Maven readback failed: HTTP {error.code}")


def maven_deploy(jar, pom, coordinate, username, password):
    group_id, artifact_id, version = coordinate.split(":")
    settings = tempfile.NamedTemporaryFile(
        mode="w", suffix=".xml", prefix="managed-release-settings-", delete=False)
    try:
        settings.write(
            "<settings><servers><server>"
            f"<id>{MAVEN_REPO_ID}</id>"
            f"<username>{xml.sax.saxutils.escape(username)}</username>"
            f"<password>{xml.sax.saxutils.escape(password)}</password>"
            "</server></servers></settings>")
        settings.close()
        os.chmod(settings.name, 0o600)
        command = [
            "mvn", "-B", "-ntp", "deploy:deploy-file",
            "-s", settings.name,
            f"-DrepositoryId={MAVEN_REPO_ID}",
            f"-Durl={MAVEN_REPO_URL}",
            f"-DgroupId={group_id}",
            f"-DartifactId={artifact_id}",
            f"-Dversion={version}",
            "-Dpackaging=jar",
            f"-Dfile={jar}",
            f"-DpomFile={pom}",
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=900)
        # Never echo stdout/stderr verbatim on failure beyond Maven's own summary;
        # Maven does not print the settings credentials, but keep the log bounded.
        if result.returncode != 0:
            tail = "\n".join(result.stdout.splitlines()[-20:])
            fail(f"Maven deploy of {coordinate} failed:\n{tail}")
        print(f"published maven {coordinate}")
    finally:
        os.unlink(settings.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--native-dir", type=Path, required=True,
                        help="Directory containing the downloaded native artifact")
    parser.add_argument("--runtime-dir", type=Path, required=True,
                        help="Directory containing the downloaded runtime artifact")
    parser.add_argument("--worker-image-dir", type=Path, required=True,
                        help="Directory containing worker-image.json")
    parser.add_argument("--harness-image-dir", type=Path, required=True,
                        help="Directory containing harness-image.json")
    parser.add_argument("--oss-skip-if-no-credential", action="store_true",
                        help="Skip OSS upload and emit manifest as local artifact when no OSS credential works")
    parser.add_argument("--expected-native-mode", choices=("package", "verify"),
                        help="Native producer mode that must match provenance")
    parser.add_argument("--bundle-out", type=Path,
                        help="verify the inputs and write a release bundle manifest without external writes")
    parser.add_argument("--published-manifest-out", type=Path,
                        help="write the final manifest here when publishing")
    parser.add_argument("--repo", type=Path, default=Path("."),
                        help="qwen-code checkout (for resolve-oss-sts.sh fallback)")
    args = parser.parse_args()

    if len(args.source_sha) != 40 or any(c not in "0123456789abcdef" for c in args.source_sha):
        fail("sourceSha must be a full lowercase 40-hex commit SHA")

    plan = verify_inputs(args.native_dir, args.runtime_dir, args.release_id, args.source_sha)
    if args.expected_native_mode and plan.get("nativeMode") != args.expected_native_mode:
        fail(f"native mode {plan.get('nativeMode')!r} != expected {args.expected_native_mode!r}")
    images = {
        "worker": verify_image_record(
            args.worker_image_dir, "worker", WORKER_REPOSITORY, args.release_id,
            plan["runtimeProvenance"]),
        "harness": verify_image_record(
            args.harness_image_dir, "harness", HARNESS_REPOSITORY, args.release_id,
            plan["runtimeProvenance"]),
    }
    print(f"verified release {args.release_id} at {args.source_sha}")

    manifest = {
        "releaseId": args.release_id,
        "sourceRevision": args.source_sha,
        "nativeMode": plan["nativeMode"],
        "maven": {
            "repository": MAVEN_REPO_URL,
            "sdk": plan["sdkCoordinate"],
            "server": plan["coordinate"],
        },
        "images": images,
        "hashes": plan["hashes"],
    }
    if args.bundle_out:
        args.bundle_out.parent.mkdir(parents=True, exist_ok=True)
        args.bundle_out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        print(json.dumps(manifest, indent=2, sort_keys=True))
        print(f"verified release bundle {args.bundle_out}")
        return

    server_key = f"managedagent/java/qwen-managed-agent-server-{args.release_id}.jar"
    runtime_key = f"managedagent/runtime/{args.release_id}/qwen-runtime-{args.release_id}.tar.gz"
    manifest_key = f"managedagent/releases/{args.release_id}/release-manifest.json"

    require_maven_credentials()

    oss_name = None
    access_key = secret = security_token = None
    if not args.oss_skip_if_no_credential:
        oss_name, access_key, secret, security_token = resolve_oss_credentials(args.repo, server_key)
        print(f"credentials ok: OSS identity {oss_name}, Maven repository {MAVEN_REPO_ID}")
        for key in (runtime_key, manifest_key):
            if oss_head(key, access_key, secret, security_token) == 200:
                fail(f"OSS object already exists, refusing to overwrite: {key}")
    else:
        print("OSS credential check skipped; runtime archive and manifest will be CI artifacts only")

    # Maven deploy happens before the first OSS object, so its failure cannot strand a
    # forbid-overwrite release id on OSS without its manifest.
    maven_username = os.environ["MAVEN_USERNAME"]
    maven_password = os.environ["MAVEN_PASSWORD"]
    sdk_jar_url = artifact_url(plan["sdkCoordinate"], "jar")
    sdk_pom_url = artifact_url(plan["sdkCoordinate"], "pom")
    server_jar_url = artifact_url(plan["coordinate"], "jar")
    server_pom_url = artifact_url(plan["coordinate"], "pom")
    maven_probe(sdk_jar_url, sdk_pom_url, maven_username, maven_password)
    maven_probe(server_jar_url, server_pom_url, maven_username, maven_password)
    maven_deploy(plan["sdkJar"], plan["sdkPom"], plan["sdkCoordinate"],
                 maven_username, maven_password)
    maven_verify(sdk_jar_url, plan["hashes"]["sdkJarSha256"], maven_username, maven_password)
    maven_verify(sdk_pom_url, plan["hashes"]["sdkPomSha256"], maven_username, maven_password)
    print(f"verified maven {plan['sdkCoordinate']}")
    maven_deploy(plan["serverJar"], plan["serverPom"], plan["coordinate"],
                 maven_username, maven_password)
    maven_verify(server_jar_url, plan["hashes"]["serverJarSha256"], maven_username, maven_password)
    maven_verify(server_pom_url, plan["hashes"]["serverPomSha256"], maven_username, maven_password)
    print(f"verified maven {plan['coordinate']}")

    for coordinate, artifact, hash_key in (
        (plan["sdkCoordinate"], "jar", "sdkJarSha256"),
        (plan["sdkCoordinate"], "pom", "sdkPomSha256"),
        (plan["coordinate"], "jar", "serverJarSha256"),
        (plan["coordinate"], "pom", "serverPomSha256"),
    ):
        maven_verify(
            artifact_url(coordinate, artifact),
            plan["hashes"][hash_key],
            maven_username,
            maven_password,
            wait_seconds=60,
        )

    if oss_name:
        oss_put(server_key, plan["serverJar"], access_key, secret, security_token)
        oss_verify(server_key, plan["hashes"]["serverJarSha256"], access_key, secret, security_token)
        oss_put(runtime_key, plan["runtimeTar"], access_key, secret, security_token)
        oss_verify(runtime_key, plan["hashes"]["runtimeTarSha256"], access_key, secret, security_token)
    else:
        print("OSS upload skipped; server JAR and runtime archive remain as CI artifacts")

    manifest.update({
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bucket": BUCKET,
        "objects": ({
            "serverJar": {"key": server_key, "sha256": plan["hashes"]["serverJarSha256"]},
            "runtime": {"key": runtime_key, "sha256": plan["hashes"]["runtimeTarSha256"]},
        } if oss_name else {}),
        "maven": {
            "repository": MAVEN_REPO_URL,
            "sdk": plan["sdkCoordinate"],
            "server": plan["coordinate"],
        },
        "images": images,
        "hashes": plan["hashes"],
    })
    manifest_path = Path(tempfile.mkstemp(prefix="release-manifest-", suffix=".json")[1])
    try:
        manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        manifest_path.write_text(manifest_text)
        if args.published_manifest_out:
            args.published_manifest_out.parent.mkdir(parents=True, exist_ok=True)
            args.published_manifest_out.write_text(manifest_text)
        if oss_name:
            manifest_sha = sha256(manifest_path)
            oss_put(manifest_key, manifest_path, access_key, secret, security_token)
            oss_verify(manifest_key, manifest_sha, access_key, secret, security_token)
        else:
            print(f"manifest written locally: {manifest_path}")
    finally:
        manifest_path.unlink(missing_ok=True)
    print(f"release {args.release_id} published")


if __name__ == "__main__":
    main()
