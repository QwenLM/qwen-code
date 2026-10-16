package main

type runtimePeer struct {
	PID        int32  `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
	Digest     string `json:"digest"`
}

type gatewayIdentity struct {
	Version     string      `json:"version"`
	Incarnation string      `json:"incarnation"`
	BootID      string      `json:"bootId"`
	Peer        runtimePeer `json:"peer"`
}
