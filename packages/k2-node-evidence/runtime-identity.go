package main

import "github.com/QwenLM/qwen-code/packages/k2-node-evidence/internal/artifactset"

type runtimePeer struct {
	PID        int32  `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
	Digest     string `json:"digest"`
}

type frontendIdentity struct {
	Kubelet   runtimePeer `json:"kubelet"`
	Registrar runtimePeer `json:"registrar"`
}

type gatewayIdentity struct {
	Version     string                  `json:"version"`
	Incarnation string                  `json:"incarnation"`
	BootID      string                  `json:"bootId"`
	Peer        runtimePeer             `json:"peer"`
	Artifacts   artifactset.Observation `json:"artifacts"`
}
