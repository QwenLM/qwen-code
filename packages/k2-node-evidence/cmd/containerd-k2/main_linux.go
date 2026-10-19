//go:build linux

package main

import (
	"fmt"
	"os"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/nriobserver"
	"github.com/containerd/containerd/v2/cmd/containerd/command"
	"github.com/containerd/plugin/registry"

	_ "github.com/containerd/containerd/v2/cmd/containerd/builtins"
)

func main() {
	registry.Register(nriobserver.Registration())
	if err := command.App().Run(os.Args); err != nil {
		fmt.Fprintln(os.Stderr, "containerd-k2:", err)
		os.Exit(1)
	}
}
