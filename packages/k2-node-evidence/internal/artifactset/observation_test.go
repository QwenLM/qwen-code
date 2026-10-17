package artifactset

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func byteHash(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

func TestObservationMatchesIndependentWholeByteOracle(t *testing.T) {
	pre, profiles, compiled := fixture(t)
	files := assemble(t, pre, profiles, compiled)
	snapshot, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"source", "gateway"} {
		configuration, unit, path := "gateway-config.json", "qwen-k2-runtime-gateway.service", "/etc/qwen-k2/gateway.json"
		if role == "source" {
			configuration, unit, path = "source-config.installed.json", "qwen-k2-node-source.service", "/etc/qwen-k2/source.json"
		}
		observed, err := snapshot.Observation(role, path, files[configuration], files["shim.json"], files[unit])
		want := Observation{
			Format: "qwen-k2-installed-byte-observation/1", Role: role,
			InstallationSHA256: byteHash(files["installation.json"]), Architecture: "amd64",
			PackedSHA256: byteHash(files["packed.bin"]), PackedBytes: len(files["packed.bin"]),
			ConfigurationPath: path, ConfigurationSHA256: byteHash(files[configuration]),
			ShimConfigurationSHA256: byteHash(files["shim.json"]),
			UnitPath:                "/etc/systemd/system/" + unit, UnitSHA256: byteHash(files[unit]),
		}
		if err != nil || observed != want || snapshot.MatchObservation(role, observed) != nil {
			t.Fatal("actual role observation differs from independent original-byte hashes", role, err)
		}
		other := "source"
		if role == other {
			other = "gateway"
		}
		if snapshot.MatchObservation(other, observed) == nil {
			t.Fatal("another role's observation matched", role)
		}
	}
}

func TestObservationRefusesEveryChangedPeerField(t *testing.T) {
	pre, profiles, compiled := fixture(t)
	files := assemble(t, pre, profiles, compiled)
	snapshot, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := snapshot.Observation("gateway", "/etc/qwen-k2/gateway.json", files["gateway-config.json"], files["shim.json"], files["qwen-k2-runtime-gateway.service"])
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct {
		name   string
		mutate func(*Observation)
	}{
		{"format", func(v *Observation) { v.Format = "qwen-k2-installed-byte-observation/0" }},
		{"role", func(v *Observation) { v.Role = "source" }},
		{"installation", func(v *Observation) { v.InstallationSHA256 = byteHash(nil) }},
		{"architecture", func(v *Observation) { v.Architecture = "arm64" }},
		{"packed hash", func(v *Observation) { v.PackedSHA256 = byteHash(nil) }},
		{"packed bytes", func(v *Observation) { v.PackedBytes++ }},
		{"configuration path", func(v *Observation) { v.ConfigurationPath = "/etc/qwen-k2/source.json" }},
		{"configuration hash", func(v *Observation) { v.ConfigurationSHA256 = byteHash(nil) }},
		{"shim", func(v *Observation) { v.ShimConfigurationSHA256 = byteHash(nil) }},
		{"unit path", func(v *Observation) { v.UnitPath = "/etc/systemd/system/qwen-k2-node-source.service" }},
		{"unit hash", func(v *Observation) { v.UnitSHA256 = byteHash(nil) }},
	} {
		t.Run(change.name, func(t *testing.T) {
			changed := actual
			change.mutate(&changed)
			if snapshot.MatchObservation("gateway", changed) == nil {
				t.Fatal("changed peer observation matched")
			}
		})
	}
	for _, snapshot := range []*Snapshot{nil, {}} {
		if snapshot.MatchObservation("gateway", Observation{}) == nil {
			t.Fatal("empty independent snapshot accepted empty peer data")
		}
	}
	if snapshot.MatchObservation("unknown", actual) == nil || snapshot.MatchObservation("gateway", Observation{}) == nil {
		t.Fatal("missing peer fields or unknown role matched")
	}
}

func TestObservationRequiresActualOwnInputs(t *testing.T) {
	pre, profiles, compiled := fixture(t)
	files := assemble(t, pre, profiles, compiled)
	snapshot, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	for _, changed := range []string{"configuration", "shim", "unit", "path"} {
		configuration, shim, unit := files["gateway-config.json"], files["shim.json"], files["qwen-k2-runtime-gateway.service"]
		path := "/etc/qwen-k2/gateway.json"
		switch changed {
		case "configuration":
			configuration = append(bytes.Clone(configuration), ' ')
		case "shim":
			shim = append(bytes.Clone(shim), ' ')
		case "unit":
			unit = append(bytes.Clone(unit), ' ')
		case "path":
			path = "/etc/qwen-k2/other.json"
		}
		if _, err := snapshot.Observation("gateway", path, configuration, shim, unit); err == nil {
			t.Fatal("observation omitted actual own-input matching", changed)
		}
	}
}

func TestObservationPinsOriginalManifestBytesAndRetainsItsInputs(t *testing.T) {
	pre, profiles, compiled := fixture(t)
	files := assemble(t, pre, profiles, compiled)
	original, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := original.Observation("gateway", "/etc/qwen-k2/gateway.json", files["gateway-config.json"], files["shim.json"], files["qwen-k2-runtime-gateway.service"])
	if err != nil {
		t.Fatal(err)
	}
	files["installation.json"] = append(files["installation.json"], '\n')
	changed, err := Validate(files)
	if err != nil || changed.MatchObservation("gateway", observed) == nil {
		t.Fatal("different original manifest bytes shared an observation", err)
	}
	for name := range files {
		files[name][0] ^= 1
	}
	if original.MatchObservation("gateway", observed) != nil {
		t.Fatal("caller mutation changed retained observation inputs")
	}
}

func TestRecordedPairNeedsIndependentSnapshotComparison(t *testing.T) {
	pre, profiles, compiled := fixture(t)
	files := assemble(t, pre, profiles, compiled)
	snapshot, err := Validate(files)
	if err != nil {
		t.Fatal(err)
	}
	source, err := snapshot.Observation("source", "/etc/qwen-k2/source.json", files["source-config.installed.json"], files["shim.json"], files["qwen-k2-node-source.service"])
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := snapshot.Observation("gateway", "/etc/qwen-k2/gateway.json", files["gateway-config.json"], files["shim.json"], files["qwen-k2-runtime-gateway.service"])
	if err != nil || ValidatePair(source, gateway) != nil {
		t.Fatal("matched byte graph did not form a recorded pair", err)
	}
	changed := gateway
	changed.ConfigurationSHA256 = byteHash([]byte("another configuration"))
	if ValidatePair(source, changed) != nil || snapshot.MatchObservation("gateway", changed) == nil {
		t.Fatal("record format was confused with independent byte association")
	}
	for _, change := range []func(*Observation){
		func(v *Observation) { v.Format = "" },
		func(v *Observation) { v.Role = "source" },
		func(v *Observation) { v.InstallationSHA256 = byteHash(nil) },
		func(v *Observation) { v.Architecture = "arm64" },
		func(v *Observation) { v.PackedSHA256 = byteHash(nil) },
		func(v *Observation) { v.PackedBytes++ },
		func(v *Observation) { v.PackedBytes = 0 },
		func(v *Observation) { v.PackedBytes = 8<<20 + 1 },
		func(v *Observation) { v.ConfigurationPath = source.ConfigurationPath },
		func(v *Observation) { v.ConfigurationPath = "/etc/qwen-k2/" + strings.Repeat("x", 2048) + ".json" },
		func(v *Observation) { v.ConfigurationSHA256 = "invalid" },
		func(v *Observation) { v.ShimConfigurationSHA256 = byteHash(nil) },
		func(v *Observation) { v.UnitPath = source.UnitPath },
		func(v *Observation) { v.UnitSHA256 = "invalid" },
	} {
		changed := gateway
		change(&changed)
		if ValidatePair(source, changed) == nil {
			t.Fatal("malformed or mismatched recorded pair accepted", changed)
		}
	}
}
