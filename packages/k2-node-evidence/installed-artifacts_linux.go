//go:build linux

package main

import (
	"errors"
	"path/filepath"
	"runtime"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

func loadInstalledArtifacts(role, configuration string, retained *roleFiles) (*artifactset.Snapshot, error) {
	if role != "source" && role != "gateway" {
		return nil, errors.New("unknown installed artifact role")
	}
	for _, path := range []string{"/etc/qwen-k2", artifactset.Directory} {
		directory, err := birth.OpenProtectedDirectory(path)
		if err != nil {
			return nil, err
		}
		retained.directories = append(retained.directories, directory)
	}
	raw := make(map[string][]byte)
	total := 0
	for name, limit := range artifactset.Limits() {
		path := filepath.Join(artifactset.Directory, name)
		f, err := retained.directories[len(retained.directories)-1].OpenArtifact(name, limit)
		if err != nil {
			return nil, err
		}
		retained.files[path] = f
		data, err := f.Bytes()
		total += len(data)
		if err != nil || total > artifactset.MaxTotal {
			return nil, errors.New("protected installed artifact bytes are unavailable or oversized")
		}
		raw[name] = data
	}
	snapshot, err := artifactset.Validate(raw)
	if err != nil {
		return nil, err
	}
	if snapshot.Architecture() != runtime.GOARCH {
		return nil, errors.New("actual service architecture differs from installed artifacts")
	}
	unit := "qwen-k2-runtime-gateway.service"
	if role == "source" {
		unit = "qwen-k2-node-source.service"
	}
	unit = filepath.Join("/etc/systemd/system", unit)
	if err := retained.add(birth.ShimConfiguration, unit); err != nil {
		return nil, err
	}
	actualConfig, configErr := retained.bytes(configuration)
	actualShim, shimErr := retained.bytes(birth.ShimConfiguration)
	actualUnit, unitErr := retained.bytes(unit)
	if errors.Join(configErr, shimErr, unitErr) != nil || snapshot.Match(role, configuration, actualConfig, actualShim, actualUnit) != nil || retained.verify() != nil {
		return nil, errors.New("actual protected service inputs differ from installed artifacts")
	}
	return snapshot, nil
}
