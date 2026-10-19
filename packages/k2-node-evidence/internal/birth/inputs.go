package birth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"unicode/utf8"

	task "github.com/containerd/containerd/api/runtime/task/v3"
	"github.com/containerd/containerd/api/types/runc/options"
	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/protobuf/proto"
)

const MaxInputs = 32 << 10

type InputPolicy struct {
	BundleRoot string `json:"bundleRoot"`
	InputRoot  string `json:"inputRoot"`
	RuncPath   string `json:"runcPath"`
	RuncRoot   string `json:"runcRoot"`
	RuncSHA256 string `json:"runcSha256"`
}

type Object struct {
	Device          uint64 `json:"device"`
	Inode           uint64 `json:"inode"`
	MountID         uint64 `json:"mountId"`
	Bytes           int64  `json:"bytes"`
	SHA256          string `json:"sha256"`
	Flags           uint32 `json:"flags"`
	Mode            uint32 `json:"mode"`
	ModifiedSeconds int64  `json:"modifiedSeconds"`
	ModifiedNanos   int64  `json:"modifiedNanos"`
	ChangedSeconds  int64  `json:"changedSeconds"`
	ChangedNanos    int64  `json:"changedNanos"`
}

func SHA256(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

func Hash(value string) bool {
	raw, err := hex.DecodeString(value)
	return err == nil && len(raw) == 32 && hex.EncodeToString(raw) == value
}

func cleanAbsolute(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && path != "/" && len(path) <= 1024 && !strings.ContainsAny(path, "\x00\r\n")
}

func (p InputPolicy) Validate() error {
	for _, path := range []string{p.BundleRoot, p.InputRoot, p.RuncPath, p.RuncRoot} {
		if !cleanAbsolute(path) {
			return errors.New("birth policy requires fixed clean absolute paths")
		}
	}
	if nested(p.BundleRoot, p.InputRoot) || nested(p.InputRoot, p.BundleRoot) || nested(p.InputRoot, p.RuncRoot) || nested(p.RuncRoot, p.InputRoot) || nested(p.InputRoot, p.RuncPath) || !Hash(p.RuncSHA256) {
		return errors.New("birth input policy is invalid")
	}
	return nil
}

func nested(parent, child string) bool {
	return parent == child || strings.HasPrefix(child, parent+string(filepath.Separator))
}

// Decode rejects duplicate and unknown fields while preserving the actual input bytes.
func Decode(raw []byte, value any, limit int) error {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) {
		return errors.New("birth input exceeds its bound")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := unique(d, 0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("birth input has trailing data")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return errors.New("birth input has unsupported fields")
	}
	var fields any
	if json.Unmarshal(raw, &fields) != nil || !exactNames(fields, reflect.TypeOf(value)) {
		return errors.New("birth input field names must match exactly")
	}
	return nil
}

func unique(d *json.Decoder, depth int) error {
	if depth > 64 {
		return errors.New("birth input nesting exceeds its bound")
	}
	t, err := d.Token()
	if err != nil {
		return errors.New("invalid birth input JSON")
	}
	container, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	if container != '[' && container != '{' {
		return errors.New("invalid birth input container")
	}
	keys := make(map[string]bool)
	for d.More() {
		if container == '{' {
			key, err := d.Token()
			name, ok := key.(string)
			if err != nil || !ok || keys[name] {
				return errors.New("duplicate birth input field")
			}
			keys[name] = true
		}
		if err := unique(d, depth+1); err != nil {
			return err
		}
	}
	end, err := d.Token()
	if err != nil || container == '[' && end != json.Delim(']') || container == '{' && end != json.Delim('}') {
		return errors.New("invalid birth input terminator")
	}
	return nil
}

func exactNames(value any, kind reflect.Type) bool {
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	if value == nil {
		return true
	}
	switch fields := value.(type) {
	case map[string]any:
		if kind.Kind() == reflect.Map {
			for _, child := range fields {
				if !exactNames(child, kind.Elem()) {
					return false
				}
			}
			return true
		}
		if kind.Kind() != reflect.Struct {
			return false
		}
		allowed := jsonFields(kind)
		for name, child := range fields {
			field, exists := allowed[name]
			if !exists || !exactNames(child, field) {
				return false
			}
		}
	case []any:
		if kind.Kind() != reflect.Slice && kind.Kind() != reflect.Array {
			return false
		}
		for _, child := range fields {
			if !exactNames(child, kind.Elem()) {
				return false
			}
		}
	}
	return true
}

func jsonFields(kind reflect.Type) map[string]reflect.Type {
	allowed := make(map[string]reflect.Type)
	for n := 0; n < kind.NumField(); n++ {
		field := kind.Field(n)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if !field.IsExported() || name == "-" {
			continue
		}
		if field.Anonymous && name == "" && field.Type.Kind() == reflect.Struct {
			for child, value := range jsonFields(field.Type) {
				allowed[child] = value
			}
		} else {
			if name == "" {
				name = field.Name
			}
			allowed[name] = field.Type
		}
	}
	return allowed
}

func ValidateRequest(p InputPolicy, r *task.CreateTaskRequest) error {
	if p.Validate() != nil || r == nil || !Hash(r.ID) || r.Bundle != filepath.Join(p.BundleRoot, r.ID) || r.Terminal || r.Checkpoint != "" || r.ParentCheckpoint != "" || len(r.ProtoReflect().GetUnknown()) != 0 || proto.Size(r) > MaxInputs || r.Options == nil || len(r.Options.ProtoReflect().GetUnknown()) != 0 {
		return errors.New("unsupported actual birth Create request")
	}
	if ValidateIO(p, r) != nil {
		return errors.New("unsupported original birth I/O")
	}
	if r.Options.TypeUrl != "containerd.runc.v1.Options" {
		return errors.New("birth requires the fixed runc options type")
	}
	var opts options.Options
	if proto.Unmarshal(r.Options.Value, &opts) != nil || ValidateOptions(p, &opts) != nil {
		return errors.New("birth runc options differ from the fixed handler")
	}
	if len(r.Rootfs) == 0 || len(r.Rootfs) > 8 {
		return errors.New("birth requires the actual bounded rootfs mounts")
	}
	for _, mount := range r.Rootfs {
		if mount == nil || len(mount.ProtoReflect().GetUnknown()) != 0 || mount.Type == "" || mount.Source == "" || mount.Target != "" || len(mount.Options) > 64 {
			return errors.New("unsupported birth rootfs mount")
		}
	}
	return nil
}

func ValidateIO(p InputPolicy, r *task.CreateTaskRequest) error {
	if r == nil || !Hash(r.ID) || r.Stdin != "" {
		return errors.New("birth stdin is unsupported")
	}
	if r.Stdout == "" && r.Stderr == "" {
		return nil
	}
	const suffix = "/io.containerd.runtime.v2.task/k8s.io"
	if !strings.HasSuffix(p.BundleRoot, suffix) || !cleanAbsolute(r.Stdout) || !cleanAbsolute(r.Stderr) {
		return errors.New("birth supports only the original CRI FIFO paths")
	}
	root := strings.TrimSuffix(p.BundleRoot, suffix)
	ioRoot := filepath.Join(root, "io.containerd.grpc.v1.cri", "containers", r.ID, "io")
	dir := filepath.Dir(r.Stdout)
	if filepath.Dir(dir) != ioRoot || dir != filepath.Dir(r.Stderr) || filepath.Base(r.Stdout) != r.ID+"-stdout" || filepath.Base(r.Stderr) != r.ID+"-stderr" {
		return errors.New("birth I/O must belong to its original CRI container")
	}
	return nil
}

func ValidateOptions(p InputPolicy, opts *options.Options) error {
	if p.Validate() != nil || opts == nil || len(opts.ProtoReflect().GetUnknown()) != 0 || opts.BinaryName != p.RuncPath || opts.Root != p.RuncRoot || !opts.SystemdCgroup || opts.NoPivotRoot || opts.NoNewKeyring || opts.ShimCgroup != "" || opts.IoUid != 0 || opts.IoGid != 0 || opts.CriuImagePath != "" || opts.CriuWorkPath != "" || opts.TaskApiAddress != "" || opts.TaskApiVersion != 0 {
		return errors.New("birth runc options differ from the fixed handler")
	}
	return nil
}

func WorkerSpec(raw []byte) (*specs.Spec, error) {
	var spec specs.Spec
	if Decode(raw, &spec, MaxInputs) != nil || spec.Process == nil || spec.Root == nil || spec.Linux == nil || spec.Hooks != nil || spec.Process.Terminal || spec.Process.User.UID != 1000 || spec.Process.User.GID != 1000 || !spec.Process.NoNewPrivileges || spec.Process.ApparmorProfile != "qwen-k2-worker-v1" || spec.Root.Path != "rootfs" || !spec.Root.Readonly || spec.Linux.Seccomp == nil || spec.Linux.CgroupsPath == "" || len(spec.Process.Args) == 0 {
		return nil, errors.New("unsupported actual worker OCI creation input")
	}
	capabilities := spec.Process.Capabilities
	if capabilities == nil || len(capabilities.Bounding)+len(capabilities.Effective)+len(capabilities.Inheritable)+len(capabilities.Permitted)+len(capabilities.Ambient) != 0 {
		return nil, errors.New("birth worker capabilities must all be empty")
	}
	if len(spec.Process.User.AdditionalGids) > 1 || len(spec.Process.User.AdditionalGids) == 1 && spec.Process.User.AdditionalGids[0] != 1000 || spec.Process.User.Username != "" {
		return nil, errors.New("birth worker cannot acquire another user or supplementary group")
	}
	if spec.Windows != nil || spec.Solaris != nil || spec.VM != nil || len(spec.Linux.UIDMappings) != 0 || len(spec.Linux.GIDMappings) != 0 || spec.Linux.Seccomp.DefaultAction == specs.ActAllow || spec.Linux.Seccomp.DefaultAction == specs.ActLog {
		return nil, errors.New("birth requires the fixed Linux worker namespace and seccomp lane")
	}
	namespaces := make(map[specs.LinuxNamespaceType]bool)
	for _, namespace := range spec.Linux.Namespaces {
		if namespaces[namespace.Type] || namespace.Type == specs.UserNamespace || namespace.Type == specs.TimeNamespace {
			return nil, errors.New("unsupported birth worker namespace")
		}
		namespaces[namespace.Type] = true
		if (namespace.Type == specs.MountNamespace || namespace.Type == specs.PIDNamespace || namespace.Type == specs.CgroupNamespace) && namespace.Path != "" {
			return nil, errors.New("birth worker cannot inherit a mount or PID namespace")
		}
	}
	for _, namespace := range []specs.LinuxNamespaceType{specs.MountNamespace, specs.PIDNamespace, specs.NetworkNamespace, specs.IPCNamespace, specs.UTSNamespace, specs.CgroupNamespace} {
		if !namespaces[namespace] {
			return nil, errors.New("birth worker namespace is missing")
		}
	}
	if len(namespaces) != 6 {
		return nil, errors.New("birth worker namespace set differs")
	}
	_, grouped := spec.Annotations["io.containerd.runc.v2.group"]
	if spec.Annotations["io.kubernetes.cri.container-type"] != "container" || spec.Annotations["io.kubernetes.cri.container-name"] != "runtime" || !Hash(spec.Annotations["io.kubernetes.cri.sandbox-id"]) || spec.Annotations["io.kubernetes.cri.sandbox-uid"] == "" || spec.Annotations["io.kubernetes.cri.sandbox-name"] == "" || spec.Annotations["io.kubernetes.cri.sandbox-namespace"] == "" || grouped {
		return nil, errors.New("birth worker requires its actual original Pod annotations")
	}
	return &spec, nil
}

// ConsumedSpec preserves worker bytes and explicitly confines the original CRI sandbox.
func ConsumedSpec(raw []byte) ([]byte, *specs.Spec, error) {
	var original specs.Spec
	if err := Decode(raw, &original, MaxInputs); err != nil {
		return nil, nil, err
	}
	if original.Annotations["io.kubernetes.cri.container-type"] == "container" {
		worker, err := WorkerSpec(raw)
		return append([]byte(nil), raw...), worker, err
	}
	_, grouped := original.Annotations["io.containerd.runc.v2.group"]
	if original.Annotations["io.kubernetes.cri.container-type"] != "sandbox" || !Hash(original.Annotations["io.kubernetes.cri.sandbox-id"]) || original.Annotations["io.kubernetes.cri.sandbox-uid"] == "" || original.Annotations["io.kubernetes.cri.sandbox-name"] == "" || original.Annotations["io.kubernetes.cri.sandbox-namespace"] == "" || grouped || original.Process == nil || original.Root == nil || original.Linux == nil || original.Hooks != nil || original.Process.Terminal || original.Process.User.UID != 1000 || original.Process.User.GID != 1000 || original.Process.User.Username != "" || original.Process.ApparmorProfile != "" || len(original.Process.Args) != 1 || original.Process.Args[0] != "/pause" || original.Root.Path != "rootfs" || !original.Root.Readonly || original.Linux.CgroupsPath == "" || original.Linux.Seccomp == nil || original.Windows != nil || original.Solaris != nil || original.VM != nil || len(original.Linux.UIDMappings)+len(original.Linux.GIDMappings) != 0 {
		return nil, nil, errors.New("unsupported actual sandbox OCI creation input")
	}
	if len(original.Process.User.AdditionalGids) > 1 || len(original.Process.User.AdditionalGids) == 1 && original.Process.User.AdditionalGids[0] != 1000 || original.Linux.Seccomp.DefaultAction == specs.ActAllow || original.Linux.Seccomp.DefaultAction == specs.ActLog {
		return nil, nil, errors.New("unsupported sandbox groups or seccomp lane")
	}
	namespaces := make(map[specs.LinuxNamespaceType]bool)
	for _, namespace := range original.Linux.Namespaces {
		if namespaces[namespace.Type] || namespace.Type != specs.NetworkNamespace && namespace.Path != "" {
			return nil, nil, errors.New("sandbox cannot inherit a host namespace")
		}
		namespaces[namespace.Type] = true
	}
	for _, namespace := range []specs.LinuxNamespaceType{specs.MountNamespace, specs.PIDNamespace, specs.NetworkNamespace, specs.IPCNamespace, specs.UTSNamespace} {
		if !namespaces[namespace] {
			return nil, nil, errors.New("original sandbox namespace is missing")
		}
	}
	if len(namespaces) != 5 && (len(namespaces) != 6 || !namespaces[specs.CgroupNamespace]) {
		return nil, nil, errors.New("unsupported original sandbox namespace set")
	}
	if !namespaces[specs.CgroupNamespace] {
		original.Linux.Namespaces = append(original.Linux.Namespaces, specs.LinuxNamespace{Type: specs.CgroupNamespace})
	}
	original.Process.NoNewPrivileges = true
	original.Process.Capabilities = &specs.LinuxCapabilities{}
	original.Process.ApparmorProfile = "qwen-k2-sandbox-v1"
	consumed, err := json.Marshal(original)
	if err != nil || len(consumed) > MaxInputs {
		return nil, nil, errors.New("confined sandbox input exceeds its bound")
	}
	return consumed, &original, nil
}
