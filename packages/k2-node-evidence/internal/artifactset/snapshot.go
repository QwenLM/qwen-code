// Package artifactset checks a closed artifact byte graph. It never qualifies
// an installation or creates a runtime, storage or release capability.
package artifactset

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"reflect"
	"regexp"
	"strings"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
)

const Directory = "/etc/qwen-k2/artifacts"
const MaxTotal = 64 << 20
const snapshotRoot = "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots"

var hostRoles = []string{"runtime", "kubelet", "registrar", "plugin", "systemd", "system-bus"}

type pin struct {
	Bytes int    `json:"bytes"`
	SHA   string `json:"sha256"`
}

type manifest struct {
	Format string         `json:"format"`
	Files  map[string]pin `json:"files"`
}

type profile struct {
	Format      string            `json:"format"`
	ArtifactSHA string            `json:"artifactManifestSha256"`
	ShimSHA     string            `json:"shimConfigurationSha256"`
	Paths       map[string]string `json:"roleConfigPaths"`
	Boundaries  []string          `json:"boundaries"`
	Generators  map[string]string `json:"generators"`
	Files       map[string]pin    `json:"files"`
}

type compilation struct {
	Format       string   `json:"format"`
	Command      []string `json:"command"`
	CandidateSHA string   `json:"profileCandidateSha256"`
	ParserSHA    string   `json:"parserSha256"`
	FeaturesSHA  string   `json:"featuresSha256"`
	SourceSHA    string   `json:"sourceSha256"`
	ConfigSHA    string   `json:"parserConfigurationSha256"`
	GeneratorSHA string   `json:"generatorSha256"`
	ExitCode     int      `json:"exitCode"`
	PackedBytes  int      `json:"packedBytes"`
	PackedSHA    string   `json:"packedSha256"`
}

type executable struct {
	SHA          string `json:"sha256"`
	Bytes        int    `json:"bytes"`
	Architecture string `json:"architecture"`
}

type artifacts struct {
	Format      string                `json:"format"`
	Artifacts   map[string]executable `json:"artifacts"`
	ContractSHA string                `json:"creationContractSha256"`
	SandboxSHA  string                `json:"sandboxImageSha256"`
	WorkerSHA   string                `json:"workerImageSha256"`
	Catalogues  map[string]pin        `json:"catalogues"`
	Generators  map[string]string     `json:"generators"`
}

type shim struct {
	Inputs           birth.InputPolicy `json:"inputs"`
	SourceSocket     string            `json:"sourceSocket"`
	SourceSHA        string            `json:"sourceSha256"`
	ShimPath         string            `json:"shimPath"`
	ShimSHA          string            `json:"shimSha256"`
	SocketRoot       string            `json:"socketRoot"`
	GRPC             string            `json:"containerdGrpc"`
	TTRPC            string            `json:"containerdTtrpc"`
	CreationContract []byte            `json:"creationContract"`
}

type HostExecutable struct {
	Path  string `json:"path"`
	SHA   string `json:"sha256"`
	Label string `json:"label"`
}

type target struct {
	ColdSHA        string                    `json:"coldBootstrapSha256"`
	Format         string                    `json:"format"`
	Architecture   string                    `json:"architecture"`
	Hosts          map[string]HostExecutable `json:"hostExecutables"`
	SnapshotRoot   string                    `json:"snapshotRoot"`
	PodSlicePrefix string                    `json:"podSlicePrefix"`
	ExportRoot     string                    `json:"apparmorExportRoot"`
	SystemBus      struct {
		Socket        string `json:"socket"`
		PrivateSocket string `json:"privateSocket"`
		Label         string `json:"label"`
		Executable    struct {
			Path string `json:"path"`
			SHA  string `json:"sha256"`
		} `json:"executable"`
	} `json:"systemBus"`
	SerialPath     string            `json:"volumeSerialPath"`
	Paths          map[string]string `json:"roleConfigPaths"`
	SandboxNetwork string            `json:"sandboxNetworkNamespaceSource"`
	RootfsMounts   map[string][]struct {
		Type    string   `json:"type"`
		Source  string   `json:"source"`
		Options []string `json:"options"`
	} `json:"rootfsMounts"`
	OldRoot       string   `json:"oldRootPath"`
	HugepageSizes []string `json:"hugepageSizes"`
}

// Limits returns a fresh fixed file set; caller-controlled paths never enter it.
func Limits() map[string]int {
	r := map[string]int{}
	for _, name := range strings.Fields("installation.json artifact-manifest.json shim.json profile-candidate.json profile-compile.json source-config.json source-config.installed.json gateway-config.json target.json runtime.json creation-contract.json qwen-k2-node-source.service qwen-k2-runtime-gateway.service features") {
		r[name] = 64 << 10
	}
	for _, name := range []string{"qwen-k2-profiles", "worker-catalog.json", "sandbox-catalog.json"} {
		r[name] = 16 << 20
	}
	for _, name := range strings.Fields("shim.json source-config.json source-config.installed.json gateway-config.json target.json qwen-k2-node-source.service qwen-k2-runtime-gateway.service") {
		r[name] = 32 << 10
	}
	r["cold-bootstrap.json"] = 64 << 10
	r["creation-contract.json"] = birth.MaxContract
	r["packed.bin"] = 8 << 20
	r["host-policies.json"] = 64 << 10
	for _, role := range hostRoles {
		r["host-"+role+".rules"] = 1 << 20
	}
	return r
}

func decode(raw []byte, value any) error {
	if birth.Decode(raw, value, 64<<10) != nil {
		return errors.New("invalid closed artifact metadata")
	}
	var actual, required map[string]json.RawMessage
	encoded, err := json.Marshal(value)
	if err != nil || json.Unmarshal(raw, &actual) != nil || json.Unmarshal(encoded, &required) != nil || len(actual) != len(required) {
		return errors.New("all artifact metadata fields are required")
	}
	for _, token := range actual {
		if bytes.Equal(bytes.TrimSpace(token), []byte("null")) {
			return errors.New("artifact metadata fields cannot be null")
		}
	}
	return nil
}

func matches(files map[string][]byte, name string, p pin) bool {
	raw, ok := files[name]
	return ok && p.Bytes == len(raw) && birth.Hash(p.SHA) && birth.SHA256(raw) == p.SHA
}

type Snapshot struct {
	installationSHA string
	packedSHA       string
	packedBytes     int
	architecture    string
	snapshotRoot    string
	paths           map[string]string
	inputs          map[string][]byte
	hosts           map[string]HostExecutable
	hostLabels      []string
}

func (s *Snapshot) PackedSHA256() string { return s.packedSHA }
func (s *Snapshot) PackedBytes() int     { return s.packedBytes }
func (s *Snapshot) Architecture() string { return s.architecture }
func (s *Snapshot) SnapshotRoot() string { return s.snapshotRoot }

func (s *Snapshot) HostPolicyLabels() []string {
	if s == nil {
		return nil
	}
	return append([]string(nil), s.hostLabels...)
}

func (s *Snapshot) Host(name string) (HostExecutable, error) {
	if s != nil {
		if value, ok := s.hosts[name]; ok {
			return value, nil
		}
	}
	return HostExecutable{}, errors.New("original installed host role is unavailable")
}

var hostLabel = regexp.MustCompile(`^[A-Za-z0-9/][A-Za-z0-9._/-]{0,252}$`)

func validHostLabel(v string) bool {
	return hostLabel.MatchString(v) && !strings.Contains(v, "//") && !strings.HasSuffix(v, "/") && v != "unconfined" && !strings.HasPrefix(v, "qwen-k2-")
}

func validHost(v HostExecutable) bool {
	return path.IsAbs(v.Path) && path.Clean(v.Path) == v.Path && v.Path != "/" && len(v.Path) <= 2048 && !strings.ContainsAny(v.Path, "\x00\r\n") && birth.Hash(v.SHA) && validHostLabel(v.Label)
}

func (s *Snapshot) Match(role, configurationPath string, configuration, shim, unit []byte) error {
	if s == nil || !birth.Hash(s.installationSHA) || !birth.Hash(s.packedSHA) || s.packedBytes < 1 || s.packedBytes > 8<<20 || s.architecture != "amd64" && s.architecture != "arm64" || s.snapshotRoot != snapshotRoot || len(s.inputs) != 5 || len(s.paths) != 2 || role != "source" && role != "gateway" || s.paths[role] != configurationPath {
		return errors.New("actual role configuration path differs from the artifact")
	}
	name, unitName := roleInputs(role)
	if !bytes.Equal(configuration, s.inputs[name]) || !bytes.Equal(shim, s.inputs["shim.json"]) || !bytes.Equal(unit, s.inputs[unitName]) {
		return errors.New("actual role inputs differ from the installed artifact bytes")
	}
	return nil
}

// Validate compares bytes only. The real service retains and rechecks the
// protected objects before using this result; this result is not authority.
func Validate(files map[string][]byte) (*Snapshot, error) {
	limits, total := Limits(), 0
	if len(files) != len(limits) {
		return nil, errors.New("the complete fixed artifact file set is required")
	}
	for name, limit := range limits {
		raw := files[name]
		total += len(raw)
		if len(raw) == 0 || len(raw) > limit || total > MaxTotal {
			return nil, errors.New("artifact bytes exceed their fixed bounds")
		}
	}
	var m manifest
	if decode(files["installation.json"], &m) != nil || m.Format != "qwen-k2-installed-artifacts/3" || len(m.Files) != len(limits)-1 {
		return nil, errors.New("invalid installed artifact manifest")
	}
	for name := range limits {
		if name != "installation.json" && !matches(files, name, m.Files[name]) {
			return nil, errors.New("installed artifact file pin differs")
		}
	}
	var p profile
	var c compilation
	var a artifacts
	var sh shim
	var t target
	if decode(files["profile-candidate.json"], &p) != nil || decode(files["profile-compile.json"], &c) != nil || decode(files["artifact-manifest.json"], &a) != nil || decode(files["shim.json"], &sh) != nil || decode(files["target.json"], &t) != nil {
		return nil, errors.New("invalid artifact dependency metadata")
	}
	if p.Format != "qwen-k2-profile-candidate/3" || a.Format != "qwen-k2-pre-exec-artifacts/2" || c.Format != "qwen-k2-profile-compile/2" || c.ExitCode != 0 || p.ArtifactSHA != birth.SHA256(files["artifact-manifest.json"]) || p.ShimSHA != birth.SHA256(files["shim.json"]) || c.CandidateSHA != birth.SHA256(files["profile-candidate.json"]) || c.SourceSHA != birth.SHA256(files["qwen-k2-profiles"]) || c.FeaturesSHA != birth.SHA256(files["features"]) || c.ConfigSHA != birth.SHA256(nil) || !matches(files, "packed.bin", pin{c.PackedBytes, c.PackedSHA}) || !birth.Hash(c.ParserSHA) || !birth.Hash(c.GeneratorSHA) || !compileCommand(c.Command) {
		return nil, errors.New("artifact compilation dependency differs")
	}
	profileNames := strings.Fields("qwen-k2-profiles source-config.json gateway-config.json target.json runtime.json creation-contract.json qwen-k2-node-source.service qwen-k2-runtime-gateway.service")
	profileNames = append(profileNames, "host-policies.json", "cold-bootstrap.json")
	for _, role := range hostRoles {
		profileNames = append(profileNames, "host-"+role+".rules")
	}
	if len(p.Files) != len(profileNames) || len(a.Catalogues) != 2 || len(a.Artifacts) != 3 || len(a.Generators) != 2 || len(p.Generators) != 3 || len(p.Paths) != 2 || len(p.Boundaries) == 0 {
		return nil, errors.New("incomplete artifact dependency set")
	}
	for _, name := range profileNames {
		if !matches(files, name, p.Files[name]) {
			return nil, errors.New("original profile candidate bytes differ")
		}
	}
	var bases manifest
	if decode(files["host-policies.json"], &bases) != nil || bases.Format != "qwen-k2-host-policies/1" || len(bases.Files) != len(hostRoles) {
		return nil, errors.New("complete fixed host policy manifest is required")
	}
	for _, role := range hostRoles {
		name := "host-" + role + ".rules"
		if !matches(files, name, bases.Files[name]) {
			return nil, errors.New("complete host base pin differs")
		}
	}
	for _, name := range []string{"worker-catalog.json", "sandbox-catalog.json"} {
		if !matches(files, name, a.Catalogues[name]) {
			return nil, errors.New("original image catalogue bytes differ")
		}
	}
	architecture := a.Artifacts["source"].Architecture
	for _, name := range []string{"source", "shim", "runc"} {
		v := a.Artifacts[name]
		if !birth.Hash(v.SHA) || v.Bytes < 64 || v.Bytes > 128<<20 || v.Architecture != architecture || architecture != "amd64" && architecture != "arm64" {
			return nil, errors.New("original executable identities differ")
		}
	}
	for _, name := range []string{"render-profiles.py", "render-pre-exec.py", "image-catalog.py"} {
		if !birth.Hash(p.Generators[name]) || name != "render-profiles.py" && p.Generators[name] != a.Generators[name] {
			return nil, errors.New("artifact generator linkage differs")
		}
	}
	expectedInputs := birth.InputPolicy{BundleRoot: "/run/containerd/io.containerd.runtime.v2.task/k8s.io", InputRoot: "/var/lib/qwen-k2/inputs", RuncPath: "/opt/qwen-k2/bin/runc", RuncRoot: "/run/qwen-k2/runc", RuncSHA256: a.Artifacts["runc"].SHA}
	if sh.Inputs != expectedInputs || sh.SourceSocket != "/run/qwen-k2/source/birth.sock" || sh.SourceSHA != a.Artifacts["source"].SHA || sh.ShimSHA != a.Artifacts["shim"].SHA || sh.ShimPath != "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1" || sh.SocketRoot != "/run/qwen-k2/shims" || sh.GRPC != "/run/containerd/containerd.sock" || sh.TTRPC != "/run/containerd/containerd.sock.ttrpc" || !bytes.Equal(sh.CreationContract, files["creation-contract.json"]) || a.ContractSHA != birth.SHA256(sh.CreationContract) || !birth.Hash(a.WorkerSHA) || !birth.Hash(a.SandboxSHA) {
		return nil, errors.New("original protected shim dependencies differ")
	}
	if _, err := birth.ReadCreationContract(sh.CreationContract); err != nil {
		return nil, err
	}
	source, err := roleConfiguration(files["source-config.json"], "source")
	gateway, gatewayErr := roleConfiguration(files["gateway-config.json"], "gateway")
	final, replaceErr := installedSource(files["source-config.json"], c.PackedSHA)
	if err != nil || gatewayErr != nil || replaceErr != nil || source["sandboxImageSha256"] != a.SandboxSHA || source["runtimeDigest"] != gateway["runtimeDigest"] || !bytes.Equal(final, files["source-config.installed.json"]) {
		return nil, errors.New("final role configuration derivation differs")
	}
	cold, coldErr := ReadCold(files["cold-bootstrap.json"])
	if coldErr != nil || t.ColdSHA != birth.SHA256(files["cold-bootstrap.json"]) || cold.Architecture != architecture || t.Hosts["systemd"].Path != cold.Systemd.Path || t.Hosts["systemd"].SHA != cold.Systemd.SHA || t.Hosts["systemd"].Label != cold.Systemd.Label {
		return nil, errors.New("cold producer and target linkage differs")
	}
	if t.Format != "qwen-k2-profile-target/3" || t.Architecture != architecture || t.SnapshotRoot != snapshotRoot || !reflect.DeepEqual(t.Paths, p.Paths) || len(t.Hosts) != 5 {
		return nil, errors.New("original target and artifact identities differ")
	}
	labels := make(map[string]bool)
	var hostLabels []string
	for _, name := range []string{"runtime", "kubelet", "registrar", "plugin", "systemd"} {
		v := t.Hosts[name]
		if !validHost(v) || labels[v.Label] || name != "systemd" && source[name+"Digest"] != v.SHA {
			return nil, errors.New("original target and role executable digests differ")
		}
		labels[v.Label] = true
		hostLabels = append(hostLabels, v.Label)
	}
	bus := HostExecutable{Path: t.SystemBus.Executable.Path, SHA: t.SystemBus.Executable.SHA, Label: t.SystemBus.Label}
	if !validHost(bus) || labels[bus.Label] || t.SystemBus.Socket != "/run/dbus/system_bus_socket" && t.SystemBus.Socket != "/var/run/dbus/system_bus_socket" || t.SystemBus.PrivateSocket != "/run/systemd/private" {
		return nil, errors.New("distinct original system bus executable and label are required")
	}
	hostLabels = append(hostLabels, bus.Label)
	for _, role := range []string{"source", "gateway"} {
		if !configurationPath(p.Paths[role]) {
			return nil, errors.New("literal protected role configuration paths are required")
		}
	}
	private := map[string]bool{source["key"]: true, source["gatewayClientKey"]: true, gateway["key"]: true}
	if len(private) != 3 {
		return nil, errors.New("role private inputs must remain distinct")
	}
	for _, value := range []string{source["certificate"], source["authority"], source["gatewayClientCertificate"], gateway["certificate"], gateway["authority"], p.Paths["source"], p.Paths["gateway"], birthPath} {
		if private[value] {
			return nil, errors.New("private inputs cannot alias public metadata or configuration")
		}
	}
	if p.Paths["source"] == p.Paths["gateway"] || p.Paths["source"] == birthPath || p.Paths["gateway"] == birthPath {
		return nil, errors.New("role configuration paths must remain distinct")
	}
	for _, role := range []string{"source", "gateway"} {
		unit := "qwen-k2-runtime-gateway.service"
		if role == "source" {
			unit = "qwen-k2-node-source.service"
		}
		raw := files[unit]
		expected := []byte("ExecStart=/opt/qwen-k2/bin/k2-node-evidence " + role + " " + p.Paths[role] + "\n")
		if bytes.Count(raw, []byte("ExecStart=")) != 1 || !bytes.HasPrefix(raw, expected) && !bytes.Contains(raw, append([]byte("\n"), expected...)) {
			return nil, errors.New("original service argv and configuration paths differ")
		}
	}
	s := &Snapshot{installationSHA: birth.SHA256(files["installation.json"]), packedSHA: c.PackedSHA, packedBytes: c.PackedBytes, architecture: architecture, snapshotRoot: t.SnapshotRoot, paths: p.Paths, inputs: make(map[string][]byte), hosts: t.Hosts, hostLabels: hostLabels}
	for _, name := range []string{"source-config.installed.json", "gateway-config.json", "shim.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service"} {
		s.inputs[name] = bytes.Clone(files[name])
	}
	return s, nil
}

const birthPath = "/etc/qwen-k2/shim.json"

func configurationPath(v string) bool {
	return configurationFile(v) && strings.HasSuffix(v, ".json")
}

func configurationFile(v string) bool {
	if len(v) > 2048 || path.Dir(v) != "/etc/qwen-k2" || path.Clean(v) != v {
		return false
	}
	for _, c := range path.Base(v) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c)) {
			return false
		}
	}
	return true
}

func compileCommand(command []string) bool {
	if len(command) == 0 || !path.IsAbs(command[0]) || path.Clean(command[0]) != command[0] || path.Base(command[0]) != "parser" {
		return false
	}
	root := path.Dir(command[0])
	expected := []string{root + "/parser", "--config-file=" + root + "/parser.conf", "--base=" + root, "--policy-features=" + root + "/features", "--kernel-features=" + root + "/features", "--skip-kernel-load", "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error", "--Werror", "--warn=rule-not-enforced", root + "/qwen-k2-profiles"}
	return root != "/" && reflect.DeepEqual(command, expected)
}

func roleConfiguration(raw []byte, role string) (map[string]string, error) {
	var value map[string]string
	fields := "listen certificate key authority coordinatorPrincipal "
	if role == "source" {
		fields += "nodeUid driver journalRoot pluginSocket pluginDigest frontendSocket kubeletDigest registrarDigest gatewayUrl gatewayPrincipal runtimeDigest gatewayClientCertificate gatewayClientKey workerPolicySha256 sandboxImageSha256"
	} else {
		fields += "sourcePrincipal runtimeSocket runtimeDigest"
	}
	if birth.Decode(raw, &value, birth.MaxInputs) != nil || len(value) != len(strings.Fields(fields)) {
		return nil, errors.New("closed original role configuration is required")
	}
	for _, field := range strings.Fields(fields) {
		if value[field] == "" || strings.ContainsRune(value[field], 0) {
			return nil, errors.New("complete original role configuration is required")
		}
	}
	fileFields := "certificate key authority"
	digestFields := "runtimeDigest"
	if role == "source" {
		fileFields += " gatewayClientCertificate gatewayClientKey"
		digestFields += " pluginDigest kubeletDigest registrarDigest workerPolicySha256 sandboxImageSha256"
	}
	for _, field := range strings.Fields(fileFields) {
		if !configurationFile(value[field]) {
			return nil, errors.New("artifact role metadata requires literal TLS file paths, never PEM bytes")
		}
	}
	for _, field := range strings.Fields(digestFields) {
		if !birth.Hash(value[field]) {
			return nil, errors.New("artifact role digests are invalid")
		}
	}
	if role == "source" {
		u, err := url.Parse(value["gatewayUrl"])
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("artifact gateway origin cannot contain credentials or query data")
		}
	}
	return value, nil
}

func installedSource(raw []byte, packed string) ([]byte, error) {
	value, err := roleConfiguration(raw, "source")
	if err != nil || !birth.Hash(packed) || !birth.Hash(value["workerPolicySha256"]) {
		return nil, errors.New("original policy digest is required")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	for d.More() {
		key, err := d.Token()
		var token json.RawMessage
		if err != nil || d.Decode(&token) != nil {
			return nil, errors.New("original source value token unavailable")
		}
		if key == "workerPolicySha256" {
			end := int(d.InputOffset())
			result := append([]byte{}, raw[:end-len(token)]...)
			result = append(result, []byte(`"`+packed+`"`)...)
			return append(result, raw[end:]...), nil
		}
	}
	return nil, errors.New("original source policy digest is absent")
}
