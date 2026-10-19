package artifactset

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"io"
	"io/fs"
)

func read(root fs.FS, name string, limit int) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, errors.New("required original artifact file is unavailable: " + name)
	}
	info, statErr := f.Stat()
	if statErr != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > int64(limit) {
		_ = f.Close()
		return nil, errors.New("bounded regular artifact file is required: " + name)
	}
	raw, readErr := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	closeErr := f.Close()
	if readErr != nil || closeErr != nil || len(raw) > limit || int64(len(raw)) != info.Size() {
		return nil, errors.New("original artifact read failed: " + name)
	}
	return raw, nil
}

// Assemble reads named data files only. Compilation records are inputs, not
// permission to execute their command or proof of actual parser execution.
func Assemble(pre, profiles, compiled fs.FS, profileSHA, compileSHA string) (map[string][]byte, error) {
	if !birth.Hash(profileSHA) || !birth.Hash(compileSHA) {
		return nil, errors.New("both reviewed candidate and compilation digests are required")
	}
	files := make(map[string][]byte)
	for name, limit := range Limits() {
		var root fs.FS
		inputName := name
		switch name {
		case "installation.json", "source-config.installed.json":
			continue
		case "artifact-manifest.json", "shim.json", "worker-catalog.json", "sandbox-catalog.json":
			root = pre
		case "profile-compile.json":
			root, inputName = compiled, "compile.json"
		case "features", "packed.bin":
			root = compiled
		default:
			root = profiles
		}
		raw, err := read(root, inputName, limit)
		if err != nil {
			return nil, err
		}
		files[name] = raw
	}
	if birth.SHA256(files["profile-candidate.json"]) != profileSHA || birth.SHA256(files["profile-compile.json"]) != compileSHA {
		return nil, errors.New("reviewed assembly inputs differ")
	}
	for _, name := range []string{"profile-candidate.json", "qwen-k2-profiles"} {
		raw, err := read(compiled, name, Limits()[name])
		if err != nil || !bytes.Equal(raw, files[name]) {
			return nil, errors.New("original compilation inputs differ")
		}
	}
	configuration, err := read(compiled, "parser.conf", 0)
	if err != nil || len(configuration) != 0 {
		return nil, errors.New("original explicit parser configuration differs")
	}
	var c compilation
	if decode(files["profile-compile.json"], &c) != nil {
		return nil, errors.New("complete successful compilation record is required")
	}
	files["source-config.installed.json"], err = installedSource(files["source-config.json"], c.PackedSHA)
	if err != nil {
		return nil, err
	}
	m := manifest{Format: "qwen-k2-installed-artifacts/3", Files: make(map[string]pin)}
	for name, raw := range files {
		m.Files[name] = pin{len(raw), birth.SHA256(raw)}
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	files["installation.json"] = append(raw, '\n')
	if _, err := Validate(files); err != nil {
		return nil, err
	}
	return files, nil
}
