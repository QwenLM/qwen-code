package main

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const workerProfile = "qwen-k2-worker-v1"
const sourceProfile = "qwen-k2-source-v1"
const maxPolicyBytes = 8 << 20
const apparmorFSMagic = 0x5a3c69f0

type kernelObject struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

type policyFilesystem struct {
	Device  uint64 `json:"device"`
	Inode   uint64 `json:"inode"`
	MountID uint64 `json:"mountId"`
	Type    uint64 `json:"type"`
}

type workerPolicy struct {
	KernelRelease          string           `json:"kernelRelease"`
	SourceUserNamespace    kernelObject     `json:"sourceUserNamespace"`
	SourceMountNamespace   kernelObject     `json:"sourceMountNamespace"`
	SourceLsmLabel         string           `json:"sourceLsmLabel"`
	SecurityfsRoot         policyFilesystem `json:"securityfsRoot"`
	ApparmorfsRoot         policyFilesystem `json:"apparmorfsRoot"`
	ProfileDirectory       string           `json:"profileDirectory"`
	ProfileObject          kernelObject     `json:"profileObject"`
	SourceProfileDirectory string           `json:"sourceProfileDirectory"`
	SourceProfileObject    kernelObject     `json:"sourceProfileObject"`
	ProfileName            string           `json:"profileName"`
	ProfileMode            string           `json:"profileMode"`
	GlobalMode             string           `json:"globalMode"`
	LockPolicy             bool             `json:"lockPolicy"`
	NamespaceRevision      string           `json:"namespaceRevision"`
	LoadRevision           string           `json:"loadRevision"`
	RawABI                 string           `json:"rawAbi"`
	RawLink                string           `json:"rawLink"`
	RawObject              kernelObject     `json:"rawObject"`
	RawBytes               uint64           `json:"rawBytes"`
	RawSHA256              string           `json:"rawSha256"`
}

var policyDirectory = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,255}$`)
var policyABI = regexp.MustCompile(`^v[5-9]$`)

func policyRevision(value string, positive bool) error {
	if len(value) == 0 || len(value) > 19 || len(value) > 1 && value[0] == '0' {
		return errors.New("invalid kernel policy revision")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return errors.New("invalid kernel policy revision")
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || positive && n == 0 {
		return errors.New("invalid kernel policy revision")
	}
	return nil
}

func policyRawPath(link string) (string, error) {
	const prefix = "../../raw_data/"
	const suffix = "/raw_data"
	if !strings.HasPrefix(link, prefix) || !strings.HasSuffix(link, suffix) {
		return "", errors.New("unsupported kernel policy export link")
	}
	revision := strings.TrimSuffix(strings.TrimPrefix(link, prefix), suffix)
	if policyRevision(revision, false) != nil {
		return "", errors.New("unsupported kernel policy export link")
	}
	return "raw_data/" + revision, nil
}

func validatePolicy(p *workerPolicy) error {
	if p == nil || !bounded(p.KernelRelease) || p.SourceUserNamespace.Inode == 0 || p.SourceMountNamespace.Inode == 0 || p.SourceLsmLabel != sourceProfile+" (enforce)" || p.SecurityfsRoot.Type != 0x73636673 || p.ApparmorfsRoot.Type != apparmorFSMagic || p.SecurityfsRoot.Inode == 0 || p.ApparmorfsRoot.Inode == 0 || p.SecurityfsRoot.MountID == 0 || p.ApparmorfsRoot.MountID == 0 || !policyDirectory.MatchString(p.ProfileDirectory) || !policyDirectory.MatchString(p.SourceProfileDirectory) || p.ProfileDirectory == "." || p.ProfileDirectory == ".." || p.SourceProfileDirectory == "." || p.SourceProfileDirectory == ".." || p.ProfileDirectory == p.SourceProfileDirectory || p.ProfileObject.Inode == 0 || p.SourceProfileObject.Inode == 0 || p.ProfileName != workerProfile || p.ProfileMode != "enforce" || p.GlobalMode != "enforce" || !p.LockPolicy || policyRevision(p.NamespaceRevision, true) != nil || policyRevision(p.LoadRevision, false) != nil || !policyABI.MatchString(p.RawABI) || p.RawObject.Inode == 0 || p.RawBytes == 0 || p.RawBytes > maxPolicyBytes || !hashString(p.RawSHA256) {
		return errors.New("invalid loaded worker policy")
	}
	namespace, _ := strconv.ParseInt(p.NamespaceRevision, 10, 64)
	load, _ := strconv.ParseInt(p.LoadRevision, 10, 64)
	if load > namespace {
		return errors.New("policy load revision exceeds its namespace")
	}
	_, err := policyRawPath(p.RawLink)
	return err
}
