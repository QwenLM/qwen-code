package artifactset

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

// All fixtures are inert data. No parser, ELF, runtime or Linux operation runs.
func fixture(t *testing.T) (fstest.MapFS, fstest.MapFS, fstest.MapFS) {
	t.Helper()
	encode := func(v any) []byte {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	file := func(raw []byte) *fstest.MapFile { return &fstest.MapFile{Data: raw} }
	policySHA := strings.Repeat("1", 64)
	source := map[string]string{}
	for _, name := range strings.Fields("listen certificate key authority coordinatorPrincipal nodeUid driver journalRoot pluginSocket pluginDigest frontendSocket kubeletDigest registrarDigest gatewayUrl gatewayPrincipal runtimeDigest gatewayClientCertificate gatewayClientKey workerPolicySha256 sandboxImageSha256") {
		source[name] = "/etc/qwen-k2/source-" + name
	}
	source["workerPolicySha256"] = policySHA
	source["pluginDigest"] = policySHA
	source["sandboxImageSha256"] = strings.Repeat("2", 64)
	source["runtimeDigest"] = strings.Repeat("a", 64)
	source["kubeletDigest"] = strings.Repeat("b", 64)
	source["registrarDigest"] = strings.Repeat("c", 64)
	source["gatewayUrl"] = "https://127.0.0.1:9444"
	gateway := map[string]string{}
	for _, name := range strings.Fields("listen certificate key authority coordinatorPrincipal sourcePrincipal runtimeSocket runtimeDigest") {
		gateway[name] = "/etc/qwen-k2/gateway-" + name
	}
	gateway["runtimeDigest"] = source["runtimeDigest"]
	role := map[string]any{"args": []string{"/pause"}, "env": []string{}, "cwd": "/", "seccomp": map[string]string{"defaultAction": "SCMP_ACT_ERRNO"}, "mounts": []any{}, "devices": []any{}, "deviceCgroupRules": []any{}, "maskedPaths": []string{}, "readonlyPaths": []string{}}
	contract := encode(map[string]any{"format": "qwen-k2-creation-contract/1", "worker": role, "sandbox": role})
	a := artifacts{Format: "qwen-k2-pre-exec-artifacts/2", Artifacts: map[string]executable{}, ContractSHA: birth.SHA256(contract), SandboxSHA: source["sandboxImageSha256"], WorkerSHA: strings.Repeat("3", 64), Generators: map[string]string{"image-catalog.py": strings.Repeat("4", 64), "render-pre-exec.py": strings.Repeat("5", 64)}, Catalogues: map[string]pin{}}
	for _, name := range []string{"source", "shim", "runc"} {
		a.Artifacts[name] = executable{birth.SHA256([]byte("inert " + name)), 64, "amd64"}
	}
	sh := shim{Inputs: birth.InputPolicy{BundleRoot: "/run/containerd/io.containerd.runtime.v2.task/k8s.io", InputRoot: "/var/lib/qwen-k2/inputs", RuncPath: "/opt/qwen-k2/bin/runc", RuncRoot: "/run/qwen-k2/runc", RuncSHA256: a.Artifacts["runc"].SHA}, SourceSocket: "/run/qwen-k2/source/birth.sock", SourceSHA: a.Artifacts["source"].SHA, ShimPath: "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1", ShimSHA: a.Artifacts["shim"].SHA, SocketRoot: "/run/qwen-k2/shims", GRPC: "/run/containerd/containerd.sock", TTRPC: "/run/containerd/containerd.sock.ttrpc", CreationContract: contract}
	pre := fstest.MapFS{"shim.json": file(encode(sh))}
	for _, name := range []string{"worker-catalog.json", "sandbox-catalog.json"} {
		raw := []byte(`{"inert":"catalogue bytes, not native evidence"}`)
		pre[name] = file(raw)
		a.Catalogues[name] = pin{len(raw), birth.SHA256(raw)}
	}
	pre["artifact-manifest.json"] = file(encode(a))
	target := target{Format: "qwen-k2-profile-target/2", Architecture: "amd64", Hosts: map[string]HostExecutable{}, Paths: map[string]string{"source": "/etc/qwen-k2/source.json", "gateway": "/etc/qwen-k2/gateway.json"}, HugepageSizes: []string{}}
	for _, name := range []string{"runtime", "kubelet", "registrar", "plugin", "systemd"} {
		sha := source[name+"Digest"]
		if name == "systemd" {
			sha = strings.Repeat("d", 64)
		}
		target.Hosts[name] = HostExecutable{Path: "/usr/bin/" + name, SHA: sha, Label: "host-" + name}
	}
	// The map is initialized by decoding inert metadata, without mounting anything.
	_ = json.Unmarshal([]byte(`{"worker":[],"sandbox":[]}`), &target.RootfsMounts)
	profiles := fstest.MapFS{"source-config.json": file(encode(source)), "gateway-config.json": file(encode(gateway)), "target.json": file(encode(target)), "runtime.json": file([]byte(`{"inert":"runtime"}`)), "creation-contract.json": file(contract), "qwen-k2-node-source.service": file([]byte("ExecStart=/opt/qwen-k2/bin/k2-node-evidence source /etc/qwen-k2/source.json\n")), "qwen-k2-runtime-gateway.service": file([]byte("ExecStart=/opt/qwen-k2/bin/k2-node-evidence gateway /etc/qwen-k2/gateway.json\n")), "qwen-k2-profiles": file([]byte("inert policy data, not compiled or loaded"))}
	p := profile{Format: "qwen-k2-profile-candidate/1", ArtifactSHA: birth.SHA256(pre["artifact-manifest.json"].Data), ShimSHA: birth.SHA256(pre["shim.json"].Data), Paths: map[string]string{"source": "/etc/qwen-k2/source.json", "gateway": "/etc/qwen-k2/gateway.json"}, Boundaries: []string{"inert data, never qualification"}, Generators: map[string]string{"image-catalog.py": a.Generators["image-catalog.py"], "render-pre-exec.py": a.Generators["render-pre-exec.py"], "render-profiles.py": strings.Repeat("6", 64)}, Files: map[string]pin{}}
	for name, f := range profiles {
		p.Files[name] = pin{len(f.Data), birth.SHA256(f.Data)}
	}
	profiles["profile-candidate.json"] = file(encode(p))
	compiled := fstest.MapFS{"profile-candidate.json": file(bytes.Clone(profiles["profile-candidate.json"].Data)), "qwen-k2-profiles": file(bytes.Clone(profiles["qwen-k2-profiles"].Data)), "features": file([]byte("inert features")), "packed.bin": file([]byte("inert packed bytes, never installed")), "parser.conf": file([]byte{})}
	root := "/original/compile"
	c := compilation{Format: "qwen-k2-profile-compile/2", Command: []string{root + "/parser", "--config-file=" + root + "/parser.conf", "--base=" + root, "--policy-features=" + root + "/features", "--kernel-features=" + root + "/features", "--skip-kernel-load", "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error", "--Werror", "--warn=rule-not-enforced", root + "/qwen-k2-profiles"}, CandidateSHA: birth.SHA256(profiles["profile-candidate.json"].Data), ParserSHA: strings.Repeat("7", 64), FeaturesSHA: birth.SHA256(compiled["features"].Data), SourceSHA: birth.SHA256(compiled["qwen-k2-profiles"].Data), ConfigSHA: birth.SHA256(nil), GeneratorSHA: strings.Repeat("8", 64), PackedBytes: len(compiled["packed.bin"].Data), PackedSHA: birth.SHA256(compiled["packed.bin"].Data)}
	compiled["compile.json"] = file(encode(c))
	return pre, profiles, compiled
}

func assemble(t *testing.T, pre, p, c fstest.MapFS) map[string][]byte {
	t.Helper()
	files, err := Assemble(pre, p, c, birth.SHA256(p["profile-candidate.json"].Data), birth.SHA256(c["compile.json"].Data))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func repin(t *testing.T, files map[string][]byte) {
	t.Helper()
	m := manifest{Format: "qwen-k2-installed-artifacts/1", Files: map[string]pin{}}
	for name, raw := range files {
		if name != "installation.json" {
			m.Files[name] = pin{len(raw), birth.SHA256(raw)}
		}
	}
	files["installation.json"], _ = json.Marshal(m)
}

func TestAssemblePreservesOriginalCompilationAndDerivesOnlySourceDigest(t *testing.T) {
	pre, p, c := fixture(t)
	before := bytes.Clone(p["source-config.json"].Data)
	files := assemble(t, pre, p, c)
	if len(files) != 18 || !bytes.Equal(files["profile-candidate.json"], c["profile-candidate.json"].Data) || !bytes.Equal(files["source-config.json"], before) || !bytes.Equal(files["gateway-config.json"], p["gateway-config.json"].Data) {
		t.Fatal("original compilation bytes changed")
	}
	old := []byte(`"workerPolicySha256":"` + strings.Repeat("1", 64) + `"`)
	want := bytes.Replace(before, old, []byte(`"workerPolicySha256":"`+birth.SHA256(c["packed.bin"].Data)+`"`), 1)
	if !bytes.Equal(want, files["source-config.installed.json"]) || !bytes.Contains(want, []byte(`"pluginDigest":"`+strings.Repeat("1", 64)+`"`)) {
		t.Fatal("replacement changed another original value")
	}
	s, err := Validate(files)
	if err != nil || s.PackedSHA256() != birth.SHA256(c["packed.bin"].Data) || s.PackedBytes() != len(c["packed.bin"].Data) || s.Architecture() != "amd64" || s.Match("source", "/etc/qwen-k2/source.json", want, pre["shim.json"].Data, p["qwen-k2-node-source.service"].Data) != nil || s.Match("gateway", "/etc/qwen-k2/gateway.json", p["gateway-config.json"].Data, pre["shim.json"].Data, p["qwen-k2-runtime-gateway.service"].Data) != nil {
		t.Fatal("actual own-role byte matching failed", err)
	}
	for _, role := range []string{"source", "gateway", "unknown"} {
		if s.Match(role, "/etc/qwen-k2/wrong.json", want, pre["shim.json"].Data, p["qwen-k2-node-source.service"].Data) == nil {
			t.Fatal("accepted a foreign role path")
		}
	}
	files["source-config.installed.json"][0] ^= 1
	if s.Match("source", "/etc/qwen-k2/source.json", want, pre["shim.json"].Data, p["qwen-k2-node-source.service"].Data) != nil {
		t.Fatal("caller mutation changed the saved comparison")
	}
}

func TestActualRoleInputsAndEmptySnapshotRefuse(t *testing.T) {
	pre, p, c := fixture(t)
	files := assemble(t, pre, p, c)
	s, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	for _, which := range []string{"configuration", "shim", "unit"} {
		config, sh, unit := files["source-config.installed.json"], files["shim.json"], files["qwen-k2-node-source.service"]
		switch which {
		case "configuration":
			config = append(bytes.Clone(config), ' ')
		case "shim":
			sh = append(bytes.Clone(sh), ' ')
		case "unit":
			unit = append(bytes.Clone(unit), ' ')
		}
		if s.Match("source", "/etc/qwen-k2/source.json", config, sh, unit) == nil {
			t.Fatal("changed actual role input accepted", which)
		}
	}
	if new(Snapshot).Match("source", "", nil, nil, nil) == nil {
		t.Fatal("empty data snapshot matched empty actual inputs")
	}
}

func TestConfigurationMetadataCannotCarryInlineKeysOrUnknownSecrets(t *testing.T) {
	_, p, _ := fixture(t)
	for _, field := range []string{"key", "certificate", "authority", "gatewayClientKey", "gatewayClientCertificate", "password"} {
		var value map[string]string
		_ = json.Unmarshal(p["source-config.json"].Data, &value)
		value[field] = "inert PEM-shaped multiline data\nnever an actual secret"
		raw, _ := json.Marshal(value)
		if _, err := roleConfiguration(raw, "source"); err == nil {
			t.Fatal("inline or unknown secret metadata accepted", field)
		}
	}
}

func TestAllInstalledFileBytesAndMembershipAreChecked(t *testing.T) {
	pre, p, c := fixture(t)
	for name := range Limits() {
		t.Run(name, func(t *testing.T) {
			files := assemble(t, pre, p, c)
			files[name][len(files[name])-1] ^= 1
			if _, err := Validate(files); err == nil {
				t.Fatal("changed original artifact bytes accepted")
			}
		})
	}
	files := assemble(t, pre, p, c)
	files["../private-key.pem"] = []byte("not a key")
	if _, err := Validate(files); err == nil {
		t.Fatal("unexpected artifact path accepted")
	}
}

func TestRepinningDoesNotRepairDependencyOrFinalConfigurationChanges(t *testing.T) {
	pre, p, c := fixture(t)
	for _, name := range []string{"artifact-manifest.json", "shim.json", "source-config.json", "gateway-config.json", "worker-catalog.json", "sandbox-catalog.json", "features", "packed.bin", "source-config.installed.json"} {
		t.Run(name, func(t *testing.T) {
			files := assemble(t, pre, p, c)
			files[name] = append(files[name], ' ')
			repin(t, files)
			if _, err := Validate(files); err == nil {
				t.Fatal("outer manifest hash repaired an inner dependency")
			}
		})
	}
}

func TestRepinnedTargetAndUnitMustKeepRoleLinkage(t *testing.T) {
	for _, which := range []string{"architecture", "targetPath", "runtimeDigest", "emptyLabel", "unconfinedLabel", "reservedLabel", "invalidLabel", "duplicateLabel", "relativeHostPath", "uncleanHostPath", "nulHostPath", "longHostPath", "unitRole", "unitConfig"} {
		t.Run(which, func(t *testing.T) {
			pre, p, c := fixture(t)
			files := assemble(t, pre, p, c)
			name := "target.json"
			var target map[string]any
			_ = json.Unmarshal(files[name], &target)
			switch which {
			case "architecture":
				target["architecture"] = "arm64"
			case "targetPath":
				target["roleConfigPaths"].(map[string]any)["source"] = "/etc/qwen-k2/other.json"
			case "runtimeDigest":
				target["hostExecutables"].(map[string]any)["runtime"].(map[string]any)["sha256"] = strings.Repeat("e", 64)
			case "emptyLabel", "unconfinedLabel", "reservedLabel", "invalidLabel", "duplicateLabel":
				label := map[string]string{"emptyLabel": "", "unconfinedLabel": "unconfined", "reservedLabel": "qwen-k2-source-v1", "invalidLabel": "host runtime", "duplicateLabel": "host-kubelet"}[which]
				target["hostExecutables"].(map[string]any)["runtime"].(map[string]any)["label"] = label
			case "relativeHostPath", "uncleanHostPath", "nulHostPath", "longHostPath":
				path := map[string]string{"relativeHostPath": "usr/bin/runtime", "uncleanHostPath": "/usr/../bin/runtime", "nulHostPath": "/usr/bin/run\x00time", "longHostPath": "/" + strings.Repeat("a", 2048)}[which]
				target["hostExecutables"].(map[string]any)["runtime"].(map[string]any)["path"] = path
			default:
				name = "qwen-k2-node-source.service"
				old, replacement := " source ", " gateway "
				if which == "unitConfig" {
					old, replacement = "source.json", "other.json"
				}
				files[name] = bytes.Replace(files[name], []byte(old), []byte(replacement), 1)
			}
			if name == "target.json" {
				files[name], _ = json.Marshal(target)
			}
			// Repair all byte pins to reach the independent role-linkage checks.
			var candidate profile
			_ = json.Unmarshal(files["profile-candidate.json"], &candidate)
			candidate.Files[name] = pin{len(files[name]), birth.SHA256(files[name])}
			files["profile-candidate.json"], _ = json.Marshal(candidate)
			var compiled compilation
			_ = json.Unmarshal(files["profile-compile.json"], &compiled)
			compiled.CandidateSHA = birth.SHA256(files["profile-candidate.json"])
			files["profile-compile.json"], _ = json.Marshal(compiled)
			repin(t, files)
			if _, err := Validate(files); err == nil {
				t.Fatal("coherent pins repaired incorrect role linkage")
			}
		})
	}
}

func TestHostRolesAreExplicitIndependentValuesFromValidatedBytes(t *testing.T) {
	pre, p, c := fixture(t)
	files := assemble(t, pre, p, c)
	snapshot, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"runtime", "kubelet", "registrar", "plugin", "systemd"} {
		actual, err := snapshot.Host(name)
		if err != nil || actual.Path != "/usr/bin/"+name || actual.Label != "host-"+name {
			t.Fatal("host identity did not come from the original target", name, actual, err)
		}
		if name == "runtime" && actual.SHA != strings.Repeat("a", 64) || name == "plugin" && actual.SHA != strings.Repeat("1", 64) {
			t.Fatal("host digest differs from manual fixture expectation", actual)
		}
		original := actual
		actual.Path, actual.Label, actual.SHA = "changed", "changed", "changed"
		again, err := snapshot.Host(name)
		if err != nil || again != original {
			t.Fatal("caller mutation replaced the original role", name)
		}
	}
	files["target.json"][0] ^= 1
	actual, err := snapshot.Host("runtime")
	if err != nil || actual.Label != "host-runtime" {
		t.Fatal("caller byte mutation replaced the retained target value")
	}
	for _, s := range []*Snapshot{nil, {}, snapshot} {
		if _, err := s.Host("unknown"); err == nil {
			t.Fatal("unknown host role accepted")
		}
	}
	if _, err := new(Snapshot).Host("runtime"); err == nil {
		t.Fatal("empty snapshot supplied a host role")
	}
}

func TestCompilationRecordRefusesIncompleteFailedAndAmbientCommands(t *testing.T) {
	for _, field := range []string{"exitCode", "nullExit", "failedExit", "timedOut", "command", "format", "profileCandidateSha256", "packedBytes", "parserConfigurationSha256"} {
		t.Run(field, func(t *testing.T) {
			pre, p, c := fixture(t)
			var value map[string]any
			_ = json.Unmarshal(c["compile.json"].Data, &value)
			switch field {
			case "exitCode":
				delete(value, field)
			case "nullExit":
				value["exitCode"] = nil
			case "failedExit":
				value["exitCode"] = 1
			case "timedOut":
				value[field] = true
			case "command":
				value[field] = []string{"/usr/bin/parser", "--replace"}
			case "format":
				value[field] = "qwen-k2-profile-compile-attempt/2"
			case "profileCandidateSha256":
				value[field] = strings.Repeat("0", 64)
			case "packedBytes":
				value[field] = 0
			default:
				value[field] = strings.Repeat("9", 64)
			}
			c["compile.json"].Data, _ = json.Marshal(value)
			if _, err := Assemble(pre, p, c, birth.SHA256(p["profile-candidate.json"].Data), birth.SHA256(c["compile.json"].Data)); err == nil {
				t.Fatal("invalid compilation data accepted")
			}
		})
	}
}

func TestOriginalCompilationInputsAndReviewedPinsCannotChange(t *testing.T) {
	for _, name := range []string{"profile-candidate.json", "qwen-k2-profiles", "parser.conf"} {
		pre, p, c := fixture(t)
		c[name].Data = append(c[name].Data, ' ')
		if _, err := Assemble(pre, p, c, birth.SHA256(p["profile-candidate.json"].Data), birth.SHA256(c["compile.json"].Data)); err == nil {
			t.Fatal("changed original compilation input accepted", name)
		}
	}
	pre, p, c := fixture(t)
	if _, err := Assemble(pre, p, c, strings.Repeat("0", 64), birth.SHA256(c["compile.json"].Data)); err == nil {
		t.Fatal("wrong reviewed candidate digest accepted")
	}
}

func TestOriginalJSONTokenReplacementPreservesWhitespaceAndEscapedKey(t *testing.T) {
	_, p, _ := fixture(t)
	raw := bytes.Replace(p["source-config.json"].Data, []byte(`"workerPolicySha256":"`), []byte(`"workerPolicy\u0053ha256" :  "`), 1)
	raw = append([]byte(" \n"), append(raw, '\n')...)
	replacement := strings.Repeat("e", 64)
	got, err := installedSource(raw, replacement)
	want := bytes.Replace(raw, []byte(`"workerPolicy\u0053ha256" :  "`+strings.Repeat("1", 64)+`"`), []byte(`"workerPolicy\u0053ha256" :  "`+replacement+`"`), 1)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("original JSON bytes were reserialized", err)
	}
	duplicate := bytes.Replace(raw, []byte("{"), []byte(`{"workerPolicySha256":"`+strings.Repeat("1", 64)+`",`), 1)
	if _, err := installedSource(duplicate, replacement); err == nil {
		t.Fatal("duplicate original configuration key accepted")
	}
}

func TestArtifactLimitsDoNotWidenBirthInputs(t *testing.T) {
	if birth.MaxInputs != 32<<10 || Limits()["packed.bin"] != 8<<20 || Limits()["qwen-k2-profiles"] != 16<<20 || Limits()["worker-catalog.json"] != 16<<20 {
		t.Fatal("unrelated input bounds changed")
	}
	pre, p, c := fixture(t)
	files := assemble(t, pre, p, c)
	files["features"] = bytes.Repeat([]byte("x"), (64<<10)+1)
	repin(t, files)
	if _, err := Validate(files); err == nil {
		t.Fatal("oversized metadata accepted")
	}
}
