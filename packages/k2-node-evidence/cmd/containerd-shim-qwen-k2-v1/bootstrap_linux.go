//go:build linux

package main

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/birth"
	"github.com/containerd/containerd/v2/pkg/shim"
)

func runShim(ctx context.Context, manager shim.Shim, config *birth.ShimConfig) error {
	invocation, err := birth.ParseBootstrapInvocation(os.Args[1:])
	if err != nil {
		return err
	}
	if invocation == nil {
		shim.RunShim(ctx, manager)
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, birth.MaxInputs+1))
	if err != nil {
		return err
	}
	prepared, legacy, err := birth.PrepareBootstrap(*invocation, raw, config.Inputs, config.ContainerdGRPC, config.ContainerdTTRPC, config.SocketRoot)
	if err != nil {
		return err
	}
	input, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer input.Close()
	defer writer.Close()
	stdin, stdout := os.Stdin, os.Stdout
	os.Stdin = input
	defer func() { os.Stdin, os.Stdout = stdin, stdout }()
	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := writer.Write(prepared)
		writeDone <- errors.Join(writeErr, writer.Close())
	}()
	if !legacy {
		shim.RunShim(ctx, manager)
		return <-writeDone
	}
	output, capture, err := os.Pipe()
	if err != nil {
		return err
	}
	defer output.Close()
	defer capture.Close()
	type captured struct {
		raw []byte
		err error
	}
	readDone := make(chan captured, 1)
	go func() {
		defer output.Close()
		bytes, readErr := io.ReadAll(io.LimitReader(output, birth.MaxInputs+1))
		readDone <- captured{bytes, readErr}
	}()
	// The SDK start helper's detached daemon has nil Cmd.Stdout, so it does not
	// inherit this capture. All lifecycle setup and the actual manager stay in RunShim.
	os.Stdout = capture
	shim.RunShim(ctx, manager)
	os.Stdout = stdout
	closeErr := capture.Close()
	result := <-readDone
	if err := errors.Join(<-writeDone, closeErr, result.err); err != nil {
		return err
	}
	encoded, err := birth.LegacyBootstrapResult(result.raw, config.SocketRoot)
	if err != nil {
		return err
	}
	_, err = stdout.Write(encoded)
	return err
}
