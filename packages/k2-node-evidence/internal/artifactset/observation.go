package artifactset

import (
	"errors"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

// Observation associates matched bytes with a service role; it is not authority.
type Observation struct {
	Format                  string `json:"format"`
	Role                    string `json:"role"`
	InstallationSHA256      string `json:"installationSha256"`
	Architecture            string `json:"architecture"`
	PackedSHA256            string `json:"packedSha256"`
	PackedBytes             int    `json:"packedBytes"`
	ConfigurationPath       string `json:"configurationPath"`
	ConfigurationSHA256     string `json:"configurationSha256"`
	ShimConfigurationSHA256 string `json:"shimConfigurationSha256"`
	UnitPath                string `json:"unitPath"`
	UnitSHA256              string `json:"unitSha256"`
}

func (s *Snapshot) Observation(role, configurationPath string, configuration, shim, unit []byte) (Observation, error) {
	if err := s.Match(role, configurationPath, configuration, shim, unit); err != nil {
		return Observation{}, err
	}
	_, unitName := roleInputs(role)
	return Observation{
		Format: "qwen-k2-installed-byte-observation/1", Role: role,
		InstallationSHA256: s.installationSHA, Architecture: s.architecture,
		PackedSHA256: s.packedSHA, PackedBytes: s.packedBytes,
		ConfigurationPath: configurationPath, ConfigurationSHA256: birth.SHA256(configuration),
		ShimConfigurationSHA256: birth.SHA256(shim),
		UnitPath:                "/etc/systemd/system/" + unitName, UnitSHA256: birth.SHA256(unit),
	}, nil
}

// MatchObservation uses this independently validated snapshot's role inputs.
func (s *Snapshot) MatchObservation(role string, actual Observation) error {
	if s == nil {
		return errors.New("missing independent artifact snapshot")
	}
	configuration, unit := roleInputs(role)
	expected, err := s.Observation(role, s.paths[role], s.inputs[configuration], s.inputs["shim.json"], s.inputs[unit])
	if err != nil || actual != expected {
		return errors.New("peer byte observation differs from the independent artifact snapshot")
	}
	return nil
}

func roleInputs(role string) (string, string) {
	if role == "source" {
		return "source-config.installed.json", "qwen-k2-node-source.service"
	}
	return "gateway-config.json", "qwen-k2-runtime-gateway.service"
}

// ValidatePair checks recorded byte identities only, never installation trust.
func ValidatePair(source, gateway Observation) error {
	for role, value := range map[string]Observation{"source": source, "gateway": gateway} {
		_, unit := roleInputs(role)
		if value.Format != "qwen-k2-installed-byte-observation/1" || value.Role != role ||
			!birth.Hash(value.InstallationSHA256) || value.Architecture != "amd64" && value.Architecture != "arm64" ||
			!birth.Hash(value.PackedSHA256) || value.PackedBytes < 1 || value.PackedBytes > 8<<20 ||
			!configurationPath(value.ConfigurationPath) || !birth.Hash(value.ConfigurationSHA256) ||
			!birth.Hash(value.ShimConfigurationSHA256) || value.UnitPath != "/etc/systemd/system/"+unit || !birth.Hash(value.UnitSHA256) {
			return errors.New("invalid recorded role byte observation")
		}
	}
	if source.InstallationSHA256 != gateway.InstallationSHA256 || source.Architecture != gateway.Architecture ||
		source.PackedSHA256 != gateway.PackedSHA256 || source.PackedBytes != gateway.PackedBytes ||
		source.ShimConfigurationSHA256 != gateway.ShimConfigurationSHA256 || source.ConfigurationPath == gateway.ConfigurationPath {
		return errors.New("recorded roles belong to different installation bytes")
	}
	return nil
}
