//go:build linux

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/shimmanager"
	_ "github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/shimplugin"
)

func main() {
	grpc, ttrpc := os.Getenv("GRPC_ADDRESS"), os.Getenv("TTRPC_ADDRESS")
	os.Clearenv()
	_ = os.Setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
	if grpc != "" {
		_ = os.Setenv("GRPC_ADDRESS", grpc)
	}
	if ttrpc != "" {
		_ = os.Setenv("TTRPC_ADDRESS", ttrpc)
	}
	config, err := birth.LoadShimConfig()
	if err != nil || grpc != "" && grpc != config.ContainerdGRPC || ttrpc != "" && ttrpc != config.ContainerdTTRPC {
		fmt.Fprintln(os.Stderr, "actual K2 shim publisher endpoints differ from its fixed configuration")
		os.Exit(1)
	}
	_ = os.Setenv("GRPC_ADDRESS", config.ContainerdGRPC)
	_ = os.Setenv("TTRPC_ADDRESS", config.ContainerdTTRPC)
	defer config.Close()
	if err := runShim(context.Background(), shimmanager.New(), config); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
