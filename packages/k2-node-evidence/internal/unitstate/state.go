// Package unitstate compares sampled service properties. It does not qualify
// an installation or grant any runtime, storage or release capability.
package unitstate

import (
	"errors"
	"fmt"
	"path"
	"reflect"
	"strings"
)

type Identity struct {
	Invocation [16]byte
	Entered    uint64
	Started    uint64
}

func Name(role string) (string, error) {
	switch role {
	case "source":
		return "qwen-k2-node-source.service", nil
	case "gateway":
		return "qwen-k2-runtime-gateway.service", nil
	default:
		return "", errors.New("unknown effective service role")
	}
}

// Check accepts the exact D-Bus decoded types, with no string coercions or
// defaults for absent properties. Extra properties are not qualifications.
func Check(role, configuration string, pid uint32, unit, service map[string]any) (Identity, error) {
	name, err := Name(role)
	if err != nil || pid == 0 || path.Dir(configuration) != "/etc/qwen-k2" || path.Clean(configuration) != configuration || len(configuration) > 2048 || strings.ContainsAny(configuration, "\x00\r\n") || len(unit) > 1024 || len(service) > 1024 {
		return Identity{}, errors.New("invalid effective service inputs")
	}
	units := map[string]any{
		"Id": name, "Names": []string{name}, "LoadState": "loaded",
		"ActiveState": "active", "SubState": "running",
		"FragmentPath": "/etc/systemd/system/" + name, "SourcePath": "",
		"DropInPaths": []string{}, "NeedDaemonReload": false, "Transient": false,
	}
	services := map[string]any{
		"ControlGroup": "/system.slice/" + name,
		"Type":         "simple", "User": "root", "Group": "root", "DynamicUser": false,
		"Restart": "no", "MainPID": pid, "ExecMainPID": pid,
		"NoNewPrivileges": true, "CapabilityBoundingSet": uint64(1 << 19),
		"AmbientCapabilities": uint64(0),
		"AppArmorProfile":     []any{false, "qwen-k2-" + role + "-v1"},
		"RootDirectory":       "", "RootImage": "",
	}
	for _, values := range []struct{ actual, required map[string]any }{{unit, units}, {service, services}} {
		for key, want := range values.required {
			if !reflect.DeepEqual(values.actual[key], want) {
				return Identity{}, fmt.Errorf("effective service property %s differs", key)
			}
		}
	}
	for _, key := range []string{"ExecCondition", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost"} {
		commands, ok := service[key].([][]any)
		if !ok || len(commands) != 0 {
			return Identity{}, errors.New("extra effective service command or unknown command type")
		}
	}
	commands, ok := service["ExecStart"].([][]any)
	if !ok || len(commands) != 1 || len(commands[0]) != 10 {
		return Identity{}, errors.New("a single effective service command is required")
	}
	command := commands[0]
	started, startedOK := service["ExecMainStartTimestampMonotonic"].(uint64)
	commandStart, commandStartOK := command[4].(uint64)
	wallStart, wallStartOK := command[3].(uint64)
	if !startedOK || started == 0 || !commandStartOK || commandStart != started || !wallStartOK || wallStart == 0 ||
		!reflect.DeepEqual(command[:3], []any{"/opt/qwen-k2/bin/k2-node-evidence", []string{"/opt/qwen-k2/bin/k2-node-evidence", role, configuration}, false}) ||
		!reflect.DeepEqual(command[5:], []any{uint64(0), uint64(0), pid, int32(0), int32(0)}) {
		return Identity{}, errors.New("effective service command identity or lifecycle differs")
	}
	invocation, invocationOK := unit["InvocationID"].([]byte)
	entered, enteredOK := unit["ActiveEnterTimestampMonotonic"].(uint64)
	if !invocationOK || len(invocation) != 16 || !enteredOK || entered == 0 {
		return Identity{}, errors.New("effective service invocation is unavailable")
	}
	identity := Identity{Entered: entered, Started: started}
	copy(identity.Invocation[:], invocation)
	if identity.Invocation == [16]byte{} {
		return Identity{}, errors.New("effective service invocation is empty")
	}
	return identity, nil
}
