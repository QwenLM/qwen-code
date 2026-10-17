package unitstate

import (
	"strings"
	"testing"
)

// These are inert decoded property values, never a service or bus fixture.
func properties(role string) (map[string]any, map[string]any) {
	name, _ := Name(role)
	return map[string]any{
		"Id": name, "Names": []string{name}, "LoadState": "loaded",
		"ActiveState": "active", "SubState": "running",
		"FragmentPath": "/etc/systemd/system/" + name, "SourcePath": "",
		"DropInPaths": []string{}, "NeedDaemonReload": false, "Transient": false,
		"InvocationID":                  []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		"ActiveEnterTimestampMonotonic": uint64(300),
	}, map[string]any{
		"ControlGroup": "/system.slice/" + name,
		"Type":         "simple", "User": "root", "Group": "root", "DynamicUser": false,
		"Restart": "no", "MainPID": uint32(57), "ExecMainPID": uint32(57),
		"NoNewPrivileges": true, "CapabilityBoundingSet": uint64(1 << 19),
		"AmbientCapabilities": uint64(0),
		"AppArmorProfile":     []any{false, "qwen-k2-" + role + "-v1"},
		"RootDirectory":       "", "RootImage": "",
		"ExecCondition": [][]any{}, "ExecStartPre": [][]any{}, "ExecStartPost": [][]any{},
		"ExecReload": [][]any{}, "ExecStop": [][]any{}, "ExecStopPost": [][]any{},
		"ExecMainStartTimestampMonotonic": uint64(200),
		"ExecStart":                       [][]any{{"/opt/qwen-k2/bin/k2-node-evidence", []string{"/opt/qwen-k2/bin/k2-node-evidence", role, "/etc/qwen-k2/" + role + ".json"}, false, uint64(1000), uint64(200), uint64(0), uint64(0), uint32(57), int32(0), int32(0)}},
	}
}

func check(role string, unit, service map[string]any) (Identity, error) {
	return Check(role, "/etc/qwen-k2/"+role+".json", 57, unit, service)
}

func TestBothRolesAndCopiedIdentity(t *testing.T) {
	for _, role := range []string{"source", "gateway"} {
		t.Run(role, func(t *testing.T) {
			u, s := properties(role)
			identity, err := check(role, u, s)
			if err != nil || identity.Started != 200 || identity.Entered != 300 || identity.Invocation[0] != 1 {
				t.Fatalf("valid inert reading refused: %+v %v", identity, err)
			}
			u["InvocationID"].([]byte)[0] = 99
			if identity.Invocation[0] != 1 {
				t.Fatal("returned identity aliases the property bytes")
			}
			changed, err := check(role, u, s)
			if err != nil || changed == identity {
				t.Fatal("a different invocation must produce a different identity")
			}
		})
	}
}

func TestEveryPropertyRequiredAndExactlyTyped(t *testing.T) {
	u, s := properties("source")
	for index, values := range []map[string]any{u, s} {
		for key := range values {
			for _, mutation := range []string{"missing", "wrong-type"} {
				t.Run(key+"/"+mutation, func(t *testing.T) {
					u, s := properties("source")
					values := []map[string]any{u, s}[index]
					if mutation == "missing" {
						delete(values, key)
					} else {
						values[key] = struct{}{}
					}
					if _, err := check("source", u, s); err == nil {
						t.Fatal("incomplete or differently typed reading accepted")
					}
				})
			}
		}
	}
}

func TestUnsafeEffectiveSettings(t *testing.T) {
	for _, test := range []struct {
		name string
		unit bool
		key  string
		bad  any
	}{
		{"alias", true, "Names", []string{"qwen-k2-node-source.service", "other.service"}},
		{"other-id", true, "Id", "other.service"},
		{"other-fragment", true, "FragmentPath", "/usr/lib/systemd/system/qwen-k2-node-source.service"},
		{"drop-in", true, "DropInPaths", []string{"/etc/systemd/system/service.d/override.conf"}},
		{"reload-pending", true, "NeedDaemonReload", true},
		{"transient", true, "Transient", true},
		{"unloaded", true, "LoadState", "not-found"},
		{"inactive", true, "ActiveState", "inactive"},
		{"exited", true, "SubState", "exited"},
		{"other-slice", false, "ControlGroup", "/other.slice/qwen-k2-node-source.service"},
		{"empty-invocation", true, "InvocationID", make([]byte, 16)},
		{"short-invocation", true, "InvocationID", []byte{1}},
		{"long-invocation", true, "InvocationID", make([]byte, 17)},
		{"not-entered", true, "ActiveEnterTimestampMonotonic", uint64(0)},
		{"forking", false, "Type", "forking"},
		{"restart", false, "Restart", "always"},
		{"dynamic-user", false, "DynamicUser", true},
		{"other-pid", false, "MainPID", uint32(58)},
		{"other-exec-pid", false, "ExecMainPID", uint32(58)},
		{"numeric-user", false, "User", "0"},
		{"other-group", false, "Group", "other"},
		{"new-privileges", false, "NoNewPrivileges", false},
		{"extra-capability", false, "CapabilityBoundingSet", uint64(1<<19 | 1)},
		{"ambient-capability", false, "AmbientCapabilities", uint64(1 << 19)},
		{"ignored-apparmor", false, "AppArmorProfile", []any{true, "qwen-k2-source-v1"}},
		{"other-apparmor", false, "AppArmorProfile", []any{false, "unconfined"}},
		{"root-image", false, "RootImage", "/other.raw"},
		{"root-directory", false, "RootDirectory", "/other"},
		{"not-started", false, "ExecMainStartTimestampMonotonic", uint64(0)},
		{"extra-start", false, "ExecStart", [][]any{{}, {}}},
		{"short-start", false, "ExecStart", [][]any{{}}},
		{"pre-hook", false, "ExecStartPre", [][]any{{}}},
		{"post-hook", false, "ExecStartPost", [][]any{{}}},
		{"reload-hook", false, "ExecReload", [][]any{{}}},
		{"condition-hook", false, "ExecCondition", [][]any{{}}},
		{"stop-hook", false, "ExecStop", [][]any{{}}},
		{"stop-post-hook", false, "ExecStopPost", [][]any{{}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			u, s := properties("source")
			values := s
			if test.unit {
				values = u
			}
			values[test.key] = test.bad
			if _, err := check("source", u, s); err == nil {
				t.Fatal("unsafe effective setting accepted")
			}
		})
	}
}

func TestExecStartIdentityAndLifecycle(t *testing.T) {
	for index, bad := range []any{"/bin/wrapper", []string{"/opt/qwen-k2/bin/k2-node-evidence", "gateway", "/etc/qwen-k2/source.json"}, true, uint64(0), uint64(201), uint64(4000), uint64(400), uint32(58), int32(1), int32(1)} {
		u, s := properties("source")
		s["ExecStart"].([][]any)[0][index] = bad
		if _, err := check("source", u, s); err == nil {
			t.Fatalf("changed command field %d accepted", index)
		}
	}
	u, s := properties("source")
	s["ExecStart"].([][]any)[0][1] = []string{"/opt/qwen-k2/bin/k2-node-evidence", "source", "/etc/qwen-k2/other.json"}
	if _, err := check("source", u, s); err == nil {
		t.Fatal("different configuration accepted")
	}
}

func TestInvalidInputsAndAdditionalProperties(t *testing.T) {
	u, s := properties("source")
	for _, config := range []string{"", "/etc/qwen-k2/../other", "/tmp/source.json", "/etc/qwen-k2/nested/source.json", "/etc/qwen-k2/a\x00", "/etc/qwen-k2/" + strings.Repeat("x", 2048)} {
		if _, err := Check("source", config, 57, u, s); err == nil {
			t.Fatal("invalid configuration path accepted")
		}
	}
	if _, err := Check("unknown", "/etc/qwen-k2/source.json", 57, u, s); err == nil {
		t.Fatal("unknown role accepted")
	}
	if _, err := Check("source", "/etc/qwen-k2/source.json", 0, u, s); err == nil {
		t.Fatal("zero process accepted")
	}
	u["OtherSystemdProperty"] = "unqualified"
	if _, err := check("source", u, s); err != nil {
		t.Fatal("unknown properties do not replace the checked subset", err)
	}
	for len(u) <= 1024 {
		u[strings.Repeat("a", len(u))] = false
	}
	if _, err := check("source", u, s); err == nil {
		t.Fatal("unbounded property map accepted")
	}
}
