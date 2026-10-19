package main

import (
	"errors"
	"strconv"
	"strings"
)

type processSecurity struct {
	UID            [4]uint32
	GID            [4]uint32
	Group          uint32
	Capabilities   [5]uint64
	NoNewPrivs     uint32
	Seccomp        uint32
	SeccompFilters uint32
	TracerPID      uint32
}

func procDecimal(value string) (uint32, error) {
	if value == "" || len(value) > 10 || len(value) > 1 && value[0] == '0' {
		return 0, errors.New("unsupported process security number")
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, errors.New("unsupported process security number")
		}
	}
	n, err := strconv.ParseUint(value, 10, 32)
	return uint32(n), err
}

func parseProcessSecurity(raw []byte) (processSecurity, error) {
	var result processSecurity
	if len(raw) == 0 || len(raw) > 4096 || raw[len(raw)-1] != '\n' || strings.ContainsAny(string(raw), "\x00\r") {
		return result, errors.New("unsupported process status")
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(string(raw[:len(raw)-1]), "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found || key == "" {
			return result, errors.New("unsupported process status field")
		}
		for _, c := range key {
			if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
				return result, errors.New("unsupported process status field")
			}
		}
		if _, exists := fields[key]; exists {
			return result, errors.New("duplicate process status field")
		}
		fields[key] = strings.TrimSpace(value)
	}
	for _, ids := range []struct {
		key string
		out *[4]uint32
	}{{"Uid", &result.UID}, {"Gid", &result.GID}} {
		values := strings.Fields(fields[ids.key])
		if len(values) != 4 {
			return result, errors.New("incomplete process credentials")
		}
		for i, value := range values {
			n, err := procDecimal(value)
			if err != nil {
				return result, errors.New("unsupported process credentials")
			}
			ids.out[i] = n
		}
	}
	groups := strings.Fields(fields["Groups"])
	if len(groups) != 1 {
		return result, errors.New("unsupported process supplementary groups")
	}
	var err error
	result.Group, err = procDecimal(groups[0])
	if err != nil {
		return result, errors.New("unsupported process supplementary groups")
	}
	for i, key := range []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} {
		value := fields[key]
		if len(value) != 16 {
			return result, errors.New("incomplete process capabilities")
		}
		for _, c := range value {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return result, errors.New("unsupported process capability encoding")
			}
		}
		result.Capabilities[i], err = strconv.ParseUint(value, 16, 64)
		if err != nil {
			return result, errors.New("unsupported process capabilities")
		}
	}
	for _, field := range []struct {
		key string
		out *uint32
	}{{"NoNewPrivs", &result.NoNewPrivs}, {"Seccomp", &result.Seccomp}, {"Seccomp_filters", &result.SeccompFilters}, {"TracerPid", &result.TracerPID}} {
		*field.out, err = procDecimal(fields[field.key])
		if err != nil {
			return result, errors.New("incomplete process security state")
		}
	}
	return result, nil
}

func (s processSecurity) worker() bool {
	return s.UID == [4]uint32{1000, 1000, 1000, 1000} && s.GID == [4]uint32{1000, 1000, 1000, 1000} && s.Group == 1000 && s.Capabilities == [5]uint64{} && s.NoNewPrivs == 1 && s.Seccomp == 2 && s.SeccompFilters > 0 && s.TracerPID == 0
}

func (s processSecurity) source() bool {
	const sysPtrace = 1 << 19
	return s.UID == [4]uint32{} && s.GID == [4]uint32{} && s.Group == 0 && s.Capabilities == [5]uint64{0, sysPtrace, sysPtrace, sysPtrace, 0} && s.NoNewPrivs == 1 && s.Seccomp == 2 && s.SeccompFilters > 0 && s.TracerPID == 0
}
