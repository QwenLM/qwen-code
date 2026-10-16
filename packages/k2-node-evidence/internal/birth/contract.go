package birth

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"

	"github.com/opencontainers/runtime-spec/specs-go"
)

const MaxContract = 16 * 1024

type CreationRole struct {
	Args              []string                  `json:"args"`
	Env               []string                  `json:"env"`
	Cwd               string                    `json:"cwd"`
	Seccomp           *specs.LinuxSeccomp       `json:"seccomp"`
	Mounts            []specs.Mount             `json:"mounts"`
	Devices           []specs.LinuxDevice       `json:"devices"`
	DeviceCgroupRules []specs.LinuxDeviceCgroup `json:"deviceCgroupRules"`
	MaskedPaths       []string                  `json:"maskedPaths"`
	ReadonlyPaths     []string                  `json:"readonlyPaths"`
}

type contractDocument struct {
	Format  string       `json:"format"`
	Worker  CreationRole `json:"worker"`
	Sandbox CreationRole `json:"sandbox"`
}

// CreationContract compares reviewed data. It never supplies deployment authority.
type CreationContract struct {
	raw []byte
}

var contractUID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)

func ReadCreationContract(raw []byte) (*CreationContract, error) {
	var value contractDocument
	if Decode(raw, &value, MaxContract) != nil || value.Format != "qwen-k2-creation-contract/1" {
		return nil, errors.New("reviewed creation contract is unavailable")
	}
	for _, role := range []CreationRole{value.Worker, value.Sandbox} {
		if len(role.Args) == 0 || len(role.Args) > 64 || role.Env == nil || len(role.Env) > 128 || role.Cwd != "/" && !cleanAbsolute(role.Cwd) || role.Seccomp == nil || role.Seccomp.DefaultAction == "" || role.Seccomp.DefaultAction == specs.ActAllow || role.Seccomp.DefaultAction == specs.ActLog || role.Mounts == nil || len(role.Mounts) > 64 || role.Devices == nil || len(role.Devices) > 64 || role.DeviceCgroupRules == nil || len(role.DeviceCgroupRules) > 128 || role.MaskedPaths == nil || role.ReadonlyPaths == nil || len(role.MaskedPaths)+len(role.ReadonlyPaths) > 128 {
			return nil, errors.New("complete bounded creation role inputs are required")
		}
		for _, device := range role.Devices {
			if device.Path == "" || device.Type == "" {
				return nil, errors.New("complete device contract is required")
			}
		}
		for _, mount := range role.Mounts {
			if !cleanAbsolute(mount.Destination) || mount.Type == "" || mount.Source == "" || len(mount.Options) > 64 || len(mount.UIDMappings)+len(mount.GIDMappings) != 0 {
				return nil, errors.New("unsupported creation mount contract")
			}
			if _, err := expandMountSource(mount.Source, strings.Repeat("a", 64), strings.Repeat("b", 64), "00000000-0000-4000-8000-000000000001"); err != nil {
				return nil, err
			}
		}
	}
	if len(value.Sandbox.Args) != 1 || value.Sandbox.Args[0] != "/pause" {
		return nil, errors.New("the original sandbox command is required")
	}
	for _, name := range []string{"worker", "sandbox"} {
		role := contractTree(raw)[name].(map[string]any)
		if !contractStringArrays(role, "args", "env", "maskedPaths", "readonlyPaths") {
			return nil, errors.New("creation contract arrays require string elements")
		}
		for _, item := range role["mounts"].([]any) {
			if !contractStringArrays(item.(map[string]any), "options") {
				return nil, errors.New("mount options require string elements")
			}
		}
		program := role["seccomp"].(map[string]any)
		if !contractStringArrays(program, "architectures", "flags") {
			return nil, errors.New("seccomp arrays require string elements")
		}
		if syscalls, ok := program["syscalls"].([]any); ok {
			for _, item := range syscalls {
				syscall, object := item.(map[string]any)
				if !object || !contractStringArrays(syscall, "names") {
					return nil, errors.New("seccomp syscall objects and names are required")
				}
				if args, ok := syscall["args"].([]any); ok {
					for _, arg := range args {
						if _, object := arg.(map[string]any); !object {
							return nil, errors.New("seccomp argument must be an object")
						}
					}
				}
			}
		}
		for _, item := range role["deviceCgroupRules"].([]any) {
			rule, object := item.(map[string]any)
			if !object {
				return nil, errors.New("device access rule must be an object")
			}
			if _, ok := rule["allow"].(bool); !ok {
				return nil, errors.New("explicit device access decision is required")
			}
		}
	}
	return &CreationContract{raw: append([]byte(nil), raw...)}, nil
}

func contractStringArrays(object map[string]any, names ...string) bool {
	for _, name := range names {
		if object[name] == nil {
			continue
		}
		items, ok := object[name].([]any)
		if !ok {
			return false
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return false
			}
		}
	}
	return true
}

func contractTree(raw []byte) map[string]any {
	var value map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&value) // Both callers already checked the complete JSON input.
	return value
}

func expandMountSource(source, id, sandbox, uid string) (string, error) {
	value := strings.NewReplacer("${POD_UID_SYSTEMD}", strings.ReplaceAll(uid, "-", "_"), "${POD_UID}", uid,
		"${CONTAINER_ID}", id, "${SANDBOX_ID}", sandbox).Replace(source)
	if strings.ContainsAny(value, "$*?[]{}@\x00\r\n") || len(value) > 1024 || strings.HasPrefix(value, "/") && !cleanAbsolute(value) {
		return "", errors.New("creation source must be literal with only fixed identity substitutions")
	}
	return value, nil
}

func (c *CreationContract) Match(original []byte, id string) error {
	_, spec, err := ConsumedSpec(original)
	if c == nil || err != nil || !Hash(id) {
		return errors.New("actual original OCI input and reviewed contract are required")
	}
	sandbox, uid := spec.Annotations["io.kubernetes.cri.sandbox-id"], spec.Annotations["io.kubernetes.cri.sandbox-uid"]
	if !Hash(sandbox) || !contractUID.MatchString(uid) {
		return errors.New("original creation identities are unavailable")
	}
	role := "worker"
	if spec.Annotations["io.kubernetes.cri.container-type"] == "sandbox" {
		role = "sandbox"
		if id != sandbox {
			return errors.New("original sandbox identity differs")
		}
	}
	expected := contractTree(c.raw)[role].(map[string]any)
	for _, item := range expected["mounts"].([]any) {
		mount := item.(map[string]any)
		mount["source"], err = expandMountSource(mount["source"].(string), id, sandbox, uid)
		if err != nil {
			return err
		}
	}
	actual := contractTree(original)
	process, linux := actual["process"].(map[string]any), actual["linux"].(map[string]any)
	projected := map[string]any{"args": process["args"], "env": process["env"], "cwd": process["cwd"],
		"seccomp": linux["seccomp"], "mounts": actual["mounts"], "devices": linux["devices"],
		"maskedPaths": linux["maskedPaths"], "readonlyPaths": linux["readonlyPaths"], "deviceCgroupRules": nil}
	if resources, ok := linux["resources"].(map[string]any); ok {
		projected["deviceCgroupRules"] = resources["devices"]
	}
	for _, name := range []string{"env", "mounts", "devices", "maskedPaths", "readonlyPaths", "deviceCgroupRules"} {
		if projected[name] == nil {
			projected[name] = []any{}
		}
	}
	if !reflect.DeepEqual(expected, projected) {
		return errors.New("actual creation inputs differ from the reviewed role contract")
	}
	return nil
}
