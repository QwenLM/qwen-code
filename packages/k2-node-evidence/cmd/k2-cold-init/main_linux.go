//go:build linux

package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/coldboot"
)

func init() { runtime.LockOSThread() }

func main() {
	if len(os.Args) != 1 || os.Args[0] != "/opt/qwen-k2/bin/k2-cold-init" || coldboot.Run() != nil {
		_, _ = fmt.Fprintln(os.Stderr, "K2 cold boot stopped")
		os.Exit(1)
	}
	os.Exit(1)
}
