package artifactset

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestColdContractRejectsChangesEvenAfterAnOuterRepin(t *testing.T) {
	raw, err := os.ReadFile("testdata/cold-bootstrap.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCold(raw); err != nil {
		t.Fatal(err)
	}
	faults := map[string]func(map[string]any){
		"missing": func(v map[string]any) { delete(v, "kernel") },
		"old":     func(v map[string]any) { v["format"] = "qwen-k2-cold-bootstrap/0" },
		"extra":   func(v map[string]any) { v["qualified"] = true },
		"lane":    func(v map[string]any) { v["architecture"] = "arm64" },
		"helper": func(v map[string]any) {
			v["bootState"].(map[string]any)["helpers"].(map[string]any)["/proc/sys/kernel/modprobe"] = ""
		},
		"core":          func(v map[string]any) { v["bootState"].(map[string]any)["coreHard"] = 1 },
		"nullCore":      func(v map[string]any) { v["bootState"].(map[string]any)["coreSoft"] = nil },
		"missingCore":   func(v map[string]any) { delete(v["bootState"].(map[string]any), "coreSoft") },
		"nestedMissing": func(v map[string]any) { delete(v["rootfsPlan"].(map[string]any), "absent") },
		"generator":     func(v map[string]any) { delete(v["generators"].(map[string]any), "cold_boot.py") },
		"alias":         func(v map[string]any) { v["linkPlan"].(map[string]any)["/lib"] = "elsewhere" },
		"selector":      func(v map[string]any) { v["rootfsPlan"].(map[string]any)["argv"] = []string{"/sbin/init", "rescue"} },
		"null":          func(v map[string]any) { v["linkPlan"] = nil },
		"scriptWildcard": func(v map[string]any) {
			v["bootState"].(map[string]any)["scriptOutputs"].(map[string]any)["/scripts/*/ORDER"] = map[string]any{"bytes": 1, "sha256": strings.Repeat("a", 64)}
		},
		"script": func(v map[string]any) {
			delete(v["bootState"].(map[string]any)["scriptOutputs"].(map[string]any), "/init")
		},
	}
	for name, change := range faults {
		t.Run(name, func(t *testing.T) {
			var value map[string]any
			_ = json.Unmarshal(raw, &value)
			change(value)
			changed, _ := json.Marshal(value)
			if _, err := ReadCold(changed); err == nil {
				t.Fatal("cold guard accepted changed input")
			}
		})
	}
}

func TestColdFileSetsRemainClosed(t *testing.T) {
	if len(Limits()) != 26 || Limits()["cold-bootstrap.json"] != 64<<10 || Limits()["source-config.json"] != 32<<10 {
		t.Fatal("fixed artifact or existing configuration bounds changed")
	}
	pre, p, c := fixture(t)
	files := assemble(t, pre, p, c)
	delete(files, "cold-bootstrap.json")
	repin(t, files)
	if _, err := Validate(files); err == nil {
		t.Fatal("mandatory producer leaf was omitted")
	}
}
