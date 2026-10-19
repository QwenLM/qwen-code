package artifactset

import (
	_ "embed"
	"encoding/json"
	"errors"
	"path"
	"reflect"
	"regexp"
	"strings"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

// coldLaneBytes pins observed inputs, not an accepted installation or boot.
//
//go:embed cold-lane.json
var coldLaneBytes []byte

type ColdFile struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	SHA   string `json:"sha256"`
}

type ColdSystemd struct {
	ColdFile
	Label string `json:"label"`
}

type ColdDependency struct {
	ColdFile
	Lookup string `json:"lookupPath"`
}

type ColdInitrdInput struct {
	ActualPath string            `json:"actualPath"`
	Bytes      int               `json:"bytes"`
	SHA        string            `json:"sha256"`
	Links      map[string]string `json:"links"`
}

type ColdBootState struct {
	KernelRelease       string            `json:"kernelRelease"`
	KernelConfiguration ColdFile          `json:"kernelConfiguration"`
	Cmdline             string            `json:"cmdline"`
	LSM                 string            `json:"lsm"`
	Helpers             map[string]string `json:"helpers"`
	RemovedCapability   string            `json:"removedCapability"`
	CoreSoft            int               `json:"coreSoft"`
	CoreHard            int               `json:"coreHard"`
	ScriptOutputs       map[string]pin    `json:"scriptOutputs"`
}

type ColdRootfs struct {
	Directories []string          `json:"directories"`
	Target      ColdFile          `json:"target"`
	Manager     ColdFile          `json:"manager"`
	Links       map[string]string `json:"links"`
	Absent      []string          `json:"absent"`
	Empty       []string          `json:"empty"`
	Argv        []string          `json:"argv"`
	Environment []string          `json:"environment"`
}

type ColdPlan struct {
	Format       string                     `json:"format"`
	EntryKind    string                     `json:"entryKind"`
	Architecture string                     `json:"architecture"`
	Kernel       ColdFile                   `json:"kernel"`
	BaseInitrd   ColdFile                   `json:"baseInitrd"`
	InitrdInputs map[string]ColdInitrdInput `json:"initrdInputs"`
	ColdInit     ColdFile                   `json:"coldInit"`
	Systemd      ColdSystemd                `json:"systemd"`
	Dependencies []ColdDependency           `json:"systemdDependencies"`
	Links        map[string]string          `json:"linkPlan"`
	Boot         ColdBootState              `json:"bootState"`
	Rootfs       ColdRootfs                 `json:"rootfsPlan"`
	Generators   map[string]string          `json:"generators"`
}

func coldPath(v string) bool {
	return path.IsAbs(v) && path.Clean(v) == v && v != "/" && len(v) <= 2048 && !strings.ContainsAny(v, "\x00\r\n")
}

// ReadCold checks a closed byte contract. It cannot attest that its boot ran.
func ReadCold(raw []byte) (*ColdPlan, error) {
	var p ColdPlan
	if decode(raw, &p) != nil {
		return nil, errors.New("closed cold-bootstrap/1 metadata is required")
	}
	if !birth.Hash(p.ColdInit.SHA) || p.ColdInit.Bytes < 64 || p.ColdInit.Bytes > 128<<20 || !validHostLabel(p.Systemd.Label) || len(p.Generators) != 4 || len(p.Boot.ScriptOutputs) < 7 || len(p.Boot.ScriptOutputs) > 256 || len(p.Links) > 64 {
		return nil, errors.New("bounded complete cold producer inputs are required")
	}
	for _, name := range []string{"render-cold-boot.py", "package-cold-initrd.py", "cold_boot.py", "cold-lane.json"} {
		if !birth.Hash(p.Generators[name]) {
			return nil, errors.New("cold generator linkage differs")
		}
	}
	for name, v := range p.Boot.ScriptOutputs {
		known := name == "/init" || name == "/scripts/functions" || name == "/scripts/init-top/udev" || name == "/scripts/init-bottom/udev"
		if !coldPath(name) || !known && !regexp.MustCompile(`^/scripts/[A-Za-z0-9._-]+/ORDER$`).MatchString(name) || v.Bytes < 1 || v.Bytes > 1<<20 || !birth.Hash(v.SHA) {
			return nil, errors.New("cold hardened script set differs")
		}
	}
	for _, name := range []string{"/init", "/scripts/functions", "/scripts/init-top/udev", "/scripts/init-bottom/udev", "/scripts/init-top/ORDER", "/scripts/init-bottom/ORDER", "/scripts/local-bottom/ORDER"} {
		if _, ok := p.Boot.ScriptOutputs[name]; !ok {
			return nil, errors.New("a mandatory hardened entry is missing")
		}
	}
	for name, target := range p.Links {
		if !coldPath(name) || !strings.HasPrefix(name, "/usr/lib/") && name != "/lib" && name != "/lib64" && !strings.HasPrefix(name, "/usr/lib64/") || target == "" || len(target) > 2048 || strings.ContainsAny(target, "\x00\r\n") {
			return nil, errors.New("cold dynamic lookup aliases differ")
		}
	}
	for _, v := range p.Dependencies {
		if resolved, err := resolveColdLinks(v.Lookup, p.Links); err != nil || resolved != v.Path {
			return nil, errors.New("cold dependency alias does not resolve to its pinned actual path")
		}
	}
	// Only these build outputs vary. All observed lane and startup inputs remain
	// equal to the embedded, reviewed lane rather than caller-chosen guards.
	var normalized, expected map[string]any
	if json.Unmarshal(raw, &normalized) != nil || json.Unmarshal(coldLaneBytes, &expected) != nil {
		return nil, errors.New("cold byte contract unavailable")
	}
	normalized["coldInit"].(map[string]any)["bytes"] = float64(0)
	normalized["coldInit"].(map[string]any)["sha256"] = ""
	normalized["systemd"].(map[string]any)["label"] = ""
	normalized["generators"] = map[string]any{}
	normalized["linkPlan"] = map[string]any{}
	normalized["bootState"].(map[string]any)["scriptOutputs"] = map[string]any{}
	if !reflect.DeepEqual(normalized, expected) {
		return nil, errors.New("unsupported cold boot lane or startup plan")
	}
	return &p, nil
}

func resolveColdLinks(name string, links map[string]string) (string, error) {
	for count := 0; count <= 40; count++ {
		changed := false
		parts := strings.Split(strings.TrimPrefix(name, "/"), "/")
		for i := range parts {
			prefix := "/" + path.Join(parts[:i+1]...)
			if target, ok := links[prefix]; ok {
				if !path.IsAbs(target) {
					target = path.Join(path.Dir(prefix), target)
				}
				name = path.Join(append([]string{target}, parts[i+1:]...)...)
				changed = true
				break
			}
		}
		if !changed {
			return name, nil
		}
	}
	return "", errors.New("cold alias cycle")
}
