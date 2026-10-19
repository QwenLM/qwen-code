package birth

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"strings"

	bootapi "github.com/containerd/containerd/api/runtime/bootstrap/v1"
	"github.com/containerd/containerd/api/types/runc/options"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

type BootstrapInvocation struct {
	ID, Namespace, Address, Binary string
	Debug                          bool
}

// ParseBootstrapInvocation mirrors the SDK flags without modifying its global flag set.
func ParseBootstrapInvocation(args []string) (*BootstrapInvocation, error) {
	fs := flag.NewFlagSet("k2-bootstrap", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var invocation BootstrapInvocation
	var version, info bool
	var socket, debugSocket, bundle string
	fs.StringVar(&invocation.ID, "id", "", "")
	fs.StringVar(&invocation.Namespace, "namespace", "", "")
	fs.StringVar(&invocation.Address, "address", "", "")
	fs.StringVar(&invocation.Binary, "publish-binary", "", "")
	fs.BoolVar(&invocation.Debug, "debug", false, "")
	fs.BoolVar(&version, "v", false, "")
	fs.BoolVar(&version, "version", false, "")
	fs.BoolVar(&info, "info", false, "")
	fs.StringVar(&socket, "socket", "", "")
	fs.StringVar(&debugSocket, "debug-socket", "", "")
	fs.StringVar(&bundle, "bundle", "", "")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if version || info || fs.Arg(0) != "start" {
		return nil, nil
	}
	if fs.NArg() != 1 || socket != "" || debugSocket != "" || bundle != "" || !Hash(invocation.ID) || invocation.Namespace != "k8s.io" || !cleanAbsolute(invocation.Address) || invocation.Binary != "" && !cleanAbsolute(invocation.Binary) {
		return nil, errors.New("unsupported actual K2 bootstrap invocation")
	}
	return &invocation, nil
}

// PrepareBootstrap explicitly distinguishes the old Any wire message from the new
// bootstrap message: both reuse fields 1 and 2, so successful Unmarshal is ambiguous.
func PrepareBootstrap(invocation BootstrapInvocation, raw []byte, policy InputPolicy, grpc, ttrpc, socketRoot string) ([]byte, bool, error) {
	if len(raw) == 0 || len(raw) > MaxInputs || policy.Validate() != nil || !Hash(invocation.ID) || invocation.Namespace != "k8s.io" || invocation.Address != grpc || !cleanAbsolute(grpc) || !cleanAbsolute(ttrpc) || grpc == ttrpc || !cleanAbsolute(socketRoot) {
		return nil, false, errors.New("actual bounded K2 bootstrap input is required")
	}
	var envelope anypb.Any
	legacy := proto.Unmarshal(raw, &envelope) == nil && envelope.TypeUrl == "containerd.runc.v1.Options"
	var parameters bootapi.BootstrapParams
	if legacy {
		var opts options.Options
		if len(envelope.ProtoReflect().GetUnknown()) != 0 || proto.Unmarshal(envelope.Value, &opts) != nil || ValidateOptions(policy, &opts) != nil {
			return nil, false, errors.New("actual legacy K2 runc options differ")
		}
		parameters.InstanceID, parameters.Namespace = invocation.ID, invocation.Namespace
		parameters.ContainerdGrpcAddress, parameters.ContainerdTtrpcAddress = grpc, ttrpc
		parameters.ContainerdBinary = invocation.Binary
		parameters.LogLevel = bootapi.LogLevel_LOG_LEVEL_INFO
		if invocation.Debug {
			parameters.LogLevel = bootapi.LogLevel_LOG_LEVEL_DEBUG
		}
		if err := parameters.AddExtension(&anypb.Any{TypeUrl: envelope.TypeUrl, Value: append([]byte(nil), envelope.Value...)}); err != nil {
			return nil, false, err
		}
	} else if err := proto.Unmarshal(raw, &parameters); err != nil {
		return nil, false, errors.New("actual K2 bootstrap message is invalid")
	}
	if parameters.InstanceID != invocation.ID || parameters.Namespace != invocation.Namespace || parameters.ContainerdGrpcAddress != grpc || parameters.ContainerdTtrpcAddress != ttrpc || parameters.ContainerdBinary != invocation.Binary || parameters.GetSocketDir() != "" && parameters.GetSocketDir() != socketRoot {
		return nil, false, errors.New("actual K2 bootstrap caller fields differ")
	}
	parameters.SocketDir = &socketRoot
	if err := ValidateBootstrap(&parameters, policy, grpc, ttrpc, socketRoot); err != nil {
		return nil, false, err
	}
	encoded, err := proto.Marshal(&parameters)
	if err != nil || len(encoded) > MaxInputs {
		return nil, false, errors.New("actual prepared K2 bootstrap exceeds its bound")
	}
	return encoded, legacy, nil
}

func ValidateBootstrap(parameters *bootapi.BootstrapParams, policy InputPolicy, grpc, ttrpc, socketRoot string) error {
	if policy.Validate() != nil || parameters == nil || !Hash(parameters.InstanceID) || parameters.Namespace != "k8s.io" || parameters.ContainerdGrpcAddress != grpc || parameters.ContainerdTtrpcAddress != ttrpc || parameters.GetSocketDir() != socketRoot || len(parameters.ProtoReflect().GetUnknown()) != 0 || proto.Size(parameters) > MaxInputs || len(parameters.Extensions) != 1 || parameters.LogLevel != bootapi.LogLevel_LOG_LEVEL_INFO && parameters.LogLevel != bootapi.LogLevel_LOG_LEVEL_DEBUG {
		return errors.New("actual original K2 bootstrap parameters differ")
	}
	extension := parameters.Extensions[0]
	if extension == nil || len(extension.ProtoReflect().GetUnknown()) != 0 || extension.Value == nil || len(extension.Value.ProtoReflect().GetUnknown()) != 0 || extension.Value.TypeUrl != "containerd.runc.v1.Options" && extension.Value.TypeUrl != "type.googleapis.com/containerd.runc.v1.Options" {
		return errors.New("unsupported actual K2 bootstrap extension")
	}
	var opts options.Options
	if proto.Unmarshal(extension.Value.Value, &opts) != nil || ValidateOptions(policy, &opts) != nil {
		return errors.New("actual K2 bootstrap options differ")
	}
	return nil
}

func LegacyBootstrapResult(raw []byte, socketRoot string) ([]byte, error) {
	var result bootapi.BootstrapResult
	if len(raw) == 0 || len(raw) > MaxInputs || proto.Unmarshal(raw, &result) != nil || len(result.ProtoReflect().GetUnknown()) != 0 || result.Version != 3 || result.Protocol != "ttrpc" || !cleanAbsolute(socketRoot) || !strings.HasPrefix(result.Address, "unix://"+socketRoot+"/") || !cleanAbsolute(strings.TrimPrefix(result.Address, "unix://")) {
		return nil, errors.New("actual K2 bootstrap result differs")
	}
	return json.Marshal(struct {
		Version  int32  `json:"version"`
		Address  string `json:"address"`
		Protocol string `json:"protocol"`
	}{result.Version, result.Address, result.Protocol})
}
