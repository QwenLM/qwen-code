/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  extractCertificateBlocks,
  loadableCertificates,
} from './pem-certificate-blocks.js';

/**
 * Every expectation in this file was taken from Node 22 / OpenSSL 3 itself:
 * each shape was written to a file, pointed at through `NODE_EXTRA_CA_CERTS`
 * in a child process, and a real `tls.connect` to a server holding the leaf
 * these certificates anchor recorded whether the loader had taken them. The
 * three rounds of divergence this module has been through all came from
 * asserting what a well-formed PEM file looks like instead; the loader is the
 * only oracle that settles it.
 */
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUcAV/pClZmXJcMTUQ7OBXsMJfVBkwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUHJvYmUgUm9vdCBDQTAeFw0yNjA4MTkwMjIxMzRaFw0z
NjA4MTYwMjIxMzRaMBgxFjAUBgNVBAMMDVByb2JlIFJvb3QgQ0EwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDICx6ZzCl3rP/Aa33Tqb8TbFOZ7ezouwe5
7kDXA1MRFEc+gRvMP5doHiJRnhYuB9uRP+1VNGd8og8wGIY1FBtYdL1iy5rdQIF9
i+I9URdt764y88h1W5p/iMlxNO/ZeMmmZwuG0cQtdTLfQpR8QoS9kfKWGW4qGEa6
+B/ZOHRusgw5eMvG/vc8+roSttzHzbtEXrAg8GWWcCV8KQWqvN1YylJGsLWW4JGl
jDy9Q9xhPtLtYnT6zr87J/MJbdfBp0bKVveXoW2+7Nc3Ujr3gEdXhT3laQL7fFdQ
N5jW+NmVgHg5UGUjkDlusSUS44WyXdAk1NhYJimoganOafnbK9jfAgMBAAGjUzBR
MB0GA1UdDgQWBBTiORNFioXP/sD/HQpXuCMC2JN6EzAfBgNVHSMEGDAWgBTiORNF
ioXP/sD/HQpXuCMC2JN6EzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQB2Q7ivxcFlavCpt0hA6SX8Crtdg4HZYza+nLRrSDGxC0R0/c1Ax0W/nSrQ
+Cjr61zpAzFOJ516RmIKJ4La2Hv4Nwiub1rZpEMc9GXaMmgC+8Vy0rkma/RuX2ML
TjgJrasVxcR/DRB4PRDWykhdgcfp5gdubPhi/9xr1SNWyX+idR9+iJs/y/DNc9Jt
OI0+q5IPhHyu7dpgEDrOelnfSufFLl+SmS9No/EhRs1RC5zH78qsNLI8ggACOIJx
bh/8x87z7BA8oKl0WlFMNWZqOBQ1lR7cSmlhHUtC/QmJm6YNU71wpUP5+WgZHvPo
XKg878D/pA1BJ8fgC9Mrczhl6PIJ
-----END CERTIFICATE-----
`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDJjCCAg6gAwIBAgIUNWSrcDrHDnBRI6jTNPSQCS9RJcQwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUHJvYmUgUm9vdCBDQTAeFw0yNjA4MTkwMjIxMzRaFw0z
NjA4MTYwMjIxMzRaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBANJ7RJRMFrD94mIW4/OEJUSYs1feTLKMYWGfJzgb
GHlnEILhKcVnJA+DMHZ8gvfc13oOF0+OGN7RqLHx+SL7eG7AT03PS9z7Qj1tEIpS
BxHPLkIdha9fPwtL6Pvh2Pqfsm2aAOTXT4EaQjGkrVNXe5V1JxfOjoiYV+eWKFwt
d3ABd+piE9RoTZQf30guISSw2EEhQmcutaZx6w8m725tc6ZYl8jIz3yNmgtcgFfB
5CUPmowQYFfdIxOpK7MO2PHvuYx6tcnN0rwAErtuW8bVb0iWMFqJvJfdzO+1J5jW
gT/pFYjM3jTZZlibdYHwSYGTPFArUo/Z5At8MZKXqLNKsUMCAwEAAaNsMGowGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYE
FLJwKoh8gKUwkfkbgIIQEBg1zWsHMB8GA1UdIwQYMBaAFOI5E0WKhc/+wP8dCle4
IwLYk3oTMA0GCSqGSIb3DQEBCwUAA4IBAQAAcOqQ1QOnBm11zUjnamj2Co2IgWvL
HvyNQ2BTgwBVqxWtvBc0vf5VW5t9ikV+jq0uhYQJnRLZMKXlhJf73uHMsh1FRM8Z
t4HDNiD3EjHa316EnilTNVH8H+RVDstpQxo9ZXZ2ishFXBuTn1MiX74B72v3Gt5Y
u8NhUh5uAEveCCboMETItLNM6y+LwKfBazfwbnDY6MGcURjRE4/J7P2wEyIy1Ohu
ZcfT/LXbn1H8cBh1iqy9flUsQR3KRTHe84Btck0+O3KA3wGIpRGF1q/mitl7zCNJ
v6SP3sMzDfFDdKbveQk7uRIdMfMMkyDuApZHDuW1YRlQBISLn3G66YOo
-----END CERTIFICATE-----
`;

// Fixtures for the loader-parity shapes measured on Node v22.23.2 /
// OpenSSL 3.0.20: every arm below was written to disk exactly as committed
// here, pointed at through NODE_EXTRA_CA_CERTS in a child process, and a
// real `tls.connect` to a server holding `LOADER_LEAF_PEM` (signed by
// `LOADER_CA_PEM`) recorded whether the loader took the certificates.
const LOADER_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUG+Rzw+YrfN2SJQcFaxnJ5Wi+hd4wDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPUHJvYmUgTG9hZGVyIENBMB4XDTI2MDgyNDIyMjk0NFoX
DTM2MDgyMTIyMjk0NFowGjEYMBYGA1UEAwwPUHJvYmUgTG9hZGVyIENBMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvphb9G9a+LJt0jSybd7bCP/ENBIb
qItKC8voeueokD0yIJk9crDYEW5glaJYkwrFj7czvcjOFsJz9nzkW1OA6waSTvdC
go0t3uttoB7b7n9eLVANuJvDrZXoS/eQKQyy00Vp03e0EqgLaIs1Is5/xitMqTUx
mC3KPpe0bibFpEgQUANGrZ9+r0DFEja14a1h5NmCH7wiCH0I5xkVK6/DTbWrtqL3
MISBKM/Dx5V8gKlSCkWzsW1FXnG5hzG7tMjfAWhInEgszBI2f62WXBKnFgVKdYvp
/CgFTvnTFCi4r7LMHxsfSOSdn4/G6degXHiiEbkwU32eGX8w7AilPkEx3QIDAQAB
o1MwUTAdBgNVHQ4EFgQUduNFQxuTU9W3Egy5J86z6GKaW5QwHwYDVR0jBBgwFoAU
duNFQxuTU9W3Egy5J86z6GKaW5QwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAgsvjWvK1WMPI+3/kI9AhUPpuxptPfXCEn/ejvTG2oQztT0KYIp1R
2o4W43LMCv78WyezYJqynEz7zahoS63dA/0xMfckywzrItXIdC4lLmRpeMGUaIdw
Lh5NxelfS1kz0tOALT2b0iJMyfMzFnrrhx1zXApnts+DYGz6u9EY5de7if+iduAI
1jaea6X5+1UKqeZOYfhnGvyeMDptcGYbjkP26oCRnq5msETpQix+9NXwcPRNVTWH
+inYhmmvmVQwMqOhKbbXhiQibp01oSkTuTE0B0H1mtIFa8W8sbK6uJOukgp0IYD4
hLthx7zmM4aiR4B4vbFkEEYXw2MLmigqGQ==
-----END CERTIFICATE-----
`;

const LOADER_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUHKfyEuWgffm/W0GoYcP/7NZ+7UUwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPUHJvYmUgTG9hZGVyIENBMB4XDTI2MDgyNDIyMjk0NVoX
DTI4MTEyNjIyMjk0NVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvHGvGsspbi1qcfmC7eSWtspNkJYLAQdlCf0j
A0J/YB2Acog5V5lP5yJuXQmXxusAALn6KkyhPFly6RxoUwo2Cr2QBKe+g26kh7s/
sJcKwwdMbdpTGDtPWmJALqRrC7lZ8NoIs6m8QVPG8aPvufve7hGP9J7ZCayIm3rR
JuH1kIP5LR1a9F4sjLUZEXevAVAJv0FUYC0YGAMsVMgV3LXYLwWrQT+KE9J/0ufw
1aSduHIiQ+uOPMISWFskft2/xW0CyVINDeKDWBWL/RrsPr8Jod/laEffUotOeMJC
geEwkS/MH+EBMXtvem2KLGU5uXPDKFJ8qoGfjOIYTuf2GKdZPQIDAQABo14wXDAa
BgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0OBBYEFNsVxLYLW+4/g5Uk
JOSKp+1jfiItMB8GA1UdIwQYMBaAFHbjRUMbk1PVtxIMuSfOs+himluUMA0GCSqG
SIb3DQEBCwUAA4IBAQBQCJ+l7rKkxCGT9I5iONMfjS5TTkgzyfYJgHkZFj3UxOz5
uQxqWlBJelpeuI9rLxAjF1gk1HEvPG782RztTYXuivnsjB97ROS1xg1IV+WamsrS
5uWEU5GlGc9kOWrhX6psesiA/SsAUN8mu2i/kAHCEbUEh45nGSrOEFUwZF5rXCDi
WIIgKvrURna4Lkl4DOe9RdbZRX3ivgvxyNw5IaNuxtFGy6pqc9NsD7Mzz6pTouQe
BN9/FHONLnCWphzl3RDWNUyebnAfKzF7C9YKpxcRQn5otS2TtY3LfkmyIVsoVQ5n
crPxrwQkQPtzqlbJUOqJQ7nfCGdb8taT0FOWWLEB
-----END CERTIFICATE-----
`;

/** A real `openssl genrsa -traditional -aes256` block with RFC 1421 headers. */
const RFC1421_ENCRYPTED_KEY = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,DF3B55948C8F8609B0D8D2F1FEB79878

J9BRN2hq4P9LNZpVMCxspGvrWTkF6WV5nkryy59GZiNz95FVQ6ZR5kL49HrCqc0u
6DTGQfiO4C94kfG/9PKtd3BWVTqvQzcuGNeo0qe6ETwAIrzw4mNldFXJnH2h5hLS
j4g5dflGETMUt+4DI1d9f2Odxe30fsDxd7Wnm0scAIIX+OPTG6XGtDOYT5Jv4zjX
VuxajyMgjxPjy1l9+9DbcGe6E/yhOAGoOqc0/bpirWDw7cJYXGk5V6+BRBvWWbNo
0D2V7A+63u/WD6yr6EtK6iMtwYrqy4lklCJ9GgzVv3lMDTC5qXUFw2j74Lhd5Y22
D95o7uCQwCiVEPmelSe2G13MDtoRCSM/lSnz3sQSw65hQPuDh2KwNBEa3JMO5jXl
EiL1fJnCEiM7VYx4Q4BNu6iaflGayLcdmcQr9+ncTW7XjaFiuXII+fHZ0G4CMEnV
rG4MiMLalg18FKwu2xXS3uRgPIsOk06M/knJvwQ+rUZZKFzi/DEyBk6XCBeCGfNd
RFVmTT0bB2V6VRchDUuWDwXmlWx175mAhck0S74eiJSzFInqzyq6kstAIHmNxb0+
5yrxgugKX2XWhnhTMND36lJC6Qxv+GhJVreDudUmCgThxTGElPjuNE0SaGy2nwXn
NyiiSZRxBB3/s9ksSzCSoCcl78yV1dzyuJz9rg8UnQZGLTtYYwGPo5ViqQaqV8pC
CBZwPqWgBmVwEcBEDZTI0yM6UdI0MkxP8RxEktAaWzfZmvqUoNthnWKC4mFThg8A
/LcP8mePil9aQFLPM01WZ2U+rVTMgUdS/MN7h49nJlLh3+biw8yhK9lKSmInZSYu
n4/lu0XL0tDxarvlmPUnJxjBCnIOKuWHEdODwYWuqNQHKUdp1zo/UiEmpuUG644c
hsk6rwbDrRsD2h6PVOHon9J4uJsHj+vPEfiSbS9zfkRRPsTZatnbxJTApjwbVtqm
r6lHtT2fXZr5jPMoGh5kl2+zn4xbLoSRIQo5TVvNoxUPP+2nNpqtyS0XjUzzQ0i2
rmJCpF0hX6eLlCNVbBX3LHAlTxd15vCKvCMg9AZWlXJxS1rB/Rr7XctdLWV7+XEg
ro7j9o6K9rD0ShqCF5YaE6nQEIS1IkeVLTAjG3F8sbPUB3hau75HUl2SQKuCveLD
NRaeoq8tL0bHc3Xr6BdD2vnehNzAODgTcBuqd8XLdEbuvFtmGpVDPNiNYwf5G2ya
f4jp1/vE+BqKz5FLr0GppYiEIPNy0kMJ5T9AzqJpNT1HPvmstL+HjCe6Hw5ehPZg
Ea4gkXjjyGpkFJjUnfiBxTEqa1uAw+suYpkUwiPhYr2lwOjUCjncsTP1BSQZh4wf
Sf3c25iJ3dmH1Y4zECcinHpXx45kQ0Bpxdy8OzQ9TvXdC64eIVI12DCQULO3b5xe
AJzY6XIGvucsNMLj9hKumiee0hYDsd3YOc7SM0UBrl0DbO6bxAZAeE/RvoBbcKxA
dhlTdZjtCFXzz3qCT7+a90scjzLgT5oLxtqBtI4G85LZknD1lN8ppMpEfui98ppy
Xhr535X9y0Bj7DHfjvNGMplAS4PZ5qtnix1hVebr4LLRwVFqJJslhTUIgLdcgJ0f
-----END RSA PRIVATE KEY-----
`;

/** The certificate body lines of `pem`, markers stripped. */
const bodyLines = (pem: string): string[] =>
  pem.trim().split('\n').slice(1, -1);

describe('extractCertificateBlocks', () => {
  it('takes a canonical single-certificate file verbatim', () => {
    expect(extractCertificateBlocks(ROOT_PEM)).toEqual([ROOT_PEM.trim()]);
  });

  it('walks past a marker embedded in a line of prose', () => {
    // Oracle: authorized=true. OpenSSL matches `-----BEGIN ` at the START of a
    // line, so this is a comment it never sees as a block — while counting
    // markers as unanchored substrings saw markers=2 vs blocks=1 and rejected
    // the whole file, dropping a CA the workers would have trusted.
    // Ends WITH the marker on purpose: only line-start anchoring rules this
    // out, so a mutant that merely requires the trailing `-----` still fails.
    const withProse = `# exported by -----BEGIN CERTIFICATE-----\n${ROOT_PEM}`;
    expect(extractCertificateBlocks(withProse)).toEqual([ROOT_PEM.trim()]);
  });

  it('takes a body line carrying interior whitespace', () => {
    // Oracle: authorized=true. The base64 decoder skips whitespace anywhere in
    // the body; a `[A-Za-z0-9+/=]+` line match rejected it.
    const lines = bodyLines(ROOT_PEM);
    const split = [...lines];
    split[1] = `${split[1]!.slice(0, 10)} ${split[1]!.slice(10)}`;
    const spaced = `-----BEGIN CERTIFICATE-----\n${split.join('\n')}\n-----END CERTIFICATE-----\n`;
    expect(extractCertificateBlocks(spaced)).toEqual([ROOT_PEM.trim()]);
  });

  it('takes a BOM-prefixed block that opens a fresh loader scan', () => {
    // Oracle: authorized=true. The loader strips a BOM from the FIRST line
    // each of its scans reads — the file start and the line immediately
    // after a consumed block's END marker (both measured on Node v22.23.2).
    // `LEAF_PEM` ends with a newline, so the BOM below is exactly that line.
    const concatenated = `${LEAF_PEM}\uFEFF${ROOT_PEM}`;
    expect(extractCertificateBlocks(concatenated)).toEqual([
      LEAF_PEM.trim(),
      ROOT_PEM.trim(),
    ]);
  });

  it('takes a file whose first line carries the BOM', () => {
    // Oracle: authorized=true — the BOM on the first scan's first line is
    // stripped (measured on Node v22.23.2).
    expect(extractCertificateBlocks(`\uFEFF${ROOT_PEM}`)).toEqual([
      ROOT_PEM.trim(),
    ]);
  });

  // R2-21 round-15 entrance B1: the strip above used to run on ANY line. A
  // BOM is stripped only from a scan's first line; anywhere else it hides
  // the marker and the loader walks past the block. Oracle: authorized=false
  // — the blank line means the BOM'd BEGIN is NOT the first line of the next
  // scan, so the loader takes the leaf prefix ALONE with no warning
  // (measured on Node v22.23.2), while this module counted the rescued block
  // as an anchor, the boot diagnostic reported zero gaps, and every worker
  // restart-looped UNABLE_TO_VERIFY_LEAF_SIGNATURE.
  it('drops a mid-scan BOM-prefixed block, keeping the loaded prefix', () => {
    expect(extractCertificateBlocks(`${LEAF_PEM}\n\uFEFF${ROOT_PEM}`)).toEqual([
      LEAF_PEM.trim(),
    ]);
  });

  it('takes a BOM-prefixed block immediately after a consumed key block', () => {
    // Oracle: authorized=true — the line after the key block's END marker is
    // the first line of the next scan, so its BOM is stripped like a file
    // start's (measured on Node v22.23.2).
    expect(
      extractCertificateBlocks(
        `${RFC1421_ENCRYPTED_KEY}\uFEFF${LOADER_CA_PEM}`,
      ),
    ).toEqual([LOADER_CA_PEM.trim()]);
  });

  it('stops at a block whose body line carries a BOM, keeping the prefix', () => {
    // Oracle: authorized=false with `Ignoring extra certs … bad base64
    // decode` (measured on Node v22.23.2): inside a block the BOM is not a
    // base64 character, the decode fails, and the loader keeps only what it
    // already read.
    const lines = ROOT_PEM.trim().split('\n');
    lines[1] = `\uFEFF${lines[1]}`;
    expect(
      extractCertificateBlocks(`${LEAF_PEM}${lines.join('\n')}\n`),
    ).toEqual([LEAF_PEM.trim()]);
  });

  it('rejects a file whose only block has a fused end line', () => {
    // Oracle: authorized=false, and Node prints `Ignoring extra certs … bad
    // end line`. `cat a.pem b.pem` with no trailing newline in a.pem.
    expect(
      extractCertificateBlocks(`${LEAF_PEM.trimEnd()}${ROOT_PEM}`),
    ).toBeUndefined();
  });

  it('keeps the certificates loaded BEFORE a fused end line', () => {
    // Oracle: authorized=true. The loader is prefix-loading, not
    // all-or-nothing: it keeps everything up to the first malformed block and
    // loses that block and everything after it. Returning `undefined` here
    // would throw away an anchor the workers do receive.
    expect(
      extractCertificateBlocks(`${ROOT_PEM}${LEAF_PEM.trimEnd()}${LEAF_PEM}`),
    ).toEqual([ROOT_PEM.trim()]);
  });

  it('stops at a block whose body does not decode, keeping the prefix', () => {
    // Oracle: authorized=true — `bad base64 decode` ends the loop the same way
    // a bad end line does. Shape is not loadability: this body is made only of
    // base64 characters.
    const lines = bodyLines(ROOT_PEM);
    const corrupted = [...lines];
    corrupted[1] = `${corrupted[1]!.slice(0, 10)}=${corrupted[1]!.slice(11)}`;
    const file = `${ROOT_PEM}-----BEGIN CERTIFICATE-----\n${corrupted.join('\n')}\n-----END CERTIFICATE-----\n`;
    expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
  });

  it('rejects a block that never closes', () => {
    expect(
      extractCertificateBlocks('-----BEGIN CERTIFICATE-----\nAAAA\n'),
    ).toBeUndefined();
  });

  it('returns undefined for a file with no block at all', () => {
    expect(extractCertificateBlocks('')).toBeUndefined();
    expect(extractCertificateBlocks('not a certificate\n')).toBeUndefined();
  });

  it('leaves a private key out of a combined cert+key file', () => {
    // The merged bundle is written to a tmpdir NODE_EXTRA_CA_CERTS never reads
    // as a key, and a SIGKILLed daemon cannot run the `exit` cleanup — so key
    // material must never reach it.
    const combined = `${ROOT_PEM}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n`;
    expect(extractCertificateBlocks(combined)).toEqual([ROOT_PEM.trim()]);
  });

  // The key block above is LAST in every fixture that carries one — here and
  // in the supervisor's combined-PEM test — so replacing the scan's `continue`
  // with a `break` shipped green while silently dropping every certificate
  // behind the key. Node's loader keeps them: measured, `rootA + PRIVATE KEY
  // + rootB` as NODE_EXTRA_CA_CERTS authorizes where `rootA` alone fails
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE. cert+key+chain is an ordinary operator
  // file shape, so the dropped certs would be the ones anchoring the workers.
  it('keeps certificates that follow a non-certificate block', () => {
    expect(
      extractCertificateBlocks(
        `${ROOT_PEM}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n${LEAF_PEM}`,
      ),
    ).toEqual([ROOT_PEM.trim(), LEAF_PEM.trim()]);
  });

  it('stops when a non-certificate block does not decode', () => {
    expect(
      extractCertificateBlocks(
        `-----BEGIN PRIVATE KEY-----\nnot%base64\n-----END PRIVATE KEY-----\n${ROOT_PEM}`,
      ),
    ).toBeUndefined();
  });

  it('normalizes CRLF and marker/body padding to canonical PEM', () => {
    // Oracle: authorized=true for both. The bundle this feeds is written to
    // disk, so the output has to be canonical whatever the input looked like.
    expect(extractCertificateBlocks(ROOT_PEM.replace(/\n/g, '\r\n'))).toEqual([
      ROOT_PEM.trim(),
    ]);
    const padded = ROOT_PEM.trim()
      .split('\n')
      .map((line) => (line.startsWith('-----') ? `${line}  ` : `  ${line}`))
      .join('\n');
    expect(extractCertificateBlocks(padded)).toEqual([ROOT_PEM.trim()]);
  });

  it.each(['\f', '\v', '\x01', '\x1f'])(
    'takes marker lines with trailing control byte %j',
    (control) => {
      const padded = ROOT_PEM.trim()
        .split('\n')
        .map((line) => (line.startsWith('-----') ? `${line}${control}` : line))
        .join('\n');
      expect(extractCertificateBlocks(padded)).toEqual([ROOT_PEM.trim()]);
    },
  );

  it.each([
    ['a space', ' '],
    ['a tab', '\t'],
  ])('takes nothing from a file whose markers carry %s', (_label, indent) => {
    // R2-21 entrance P1. Oracle: authorized=FALSE — the one shape in the
    // padding family the loader does not tolerate. Measured on Node v22.23.0 /
    // OpenSSL 3.0.13: with this file as NODE_EXTRA_CA_CERTS the handshake
    // fails DEPTH_ZERO_SELF_SIGNED_CERT with no `Ignoring extra certs`
    // warning and `openssl storeutl -certs` reports `Total found: 0`, while
    // the same file un-indented authorizes. `normalizePemLine` stripped
    // leading whitespace before the marker match, so this module counted the
    // block as an anchor the workers never received.
    const indented = ROOT_PEM.trim()
      .split('\n')
      .map((line) => (line.startsWith('-----') ? `${indent}${line}` : line))
      .join('\n');
    expect(extractCertificateBlocks(indented)).toBeUndefined();
    // The un-indented control, so this pins the indent and not the fixture.
    expect(extractCertificateBlocks(ROOT_PEM)).toEqual([ROOT_PEM.trim()]);
  });

  // RFC 1421 header lines — the `Proc-Type:`/`DEK-Info:` pair between the
  // BEGIN marker and the first blank line of a legacy encrypted key. The
  // loader parses them, skips the block and CONTINUES: measured on Node
  // v22.23.2 as NODE_EXTRA_CA_CERTS in both orderings, authorized=true.
  // Feeding the header text to the base64 judgement used to break the scan
  // here and drop every certificate after such a block.
  it('keeps certificates that follow an RFC-1421 headered key block', () => {
    expect(
      extractCertificateBlocks(`${RFC1421_ENCRYPTED_KEY}\n${LOADER_CA_PEM}`),
    ).toEqual([LOADER_CA_PEM.trim()]);
    expect(
      extractCertificateBlocks(
        `${LOADER_CA_PEM}\n${RFC1421_ENCRYPTED_KEY}\n${LOADER_LEAF_PEM}`,
      ),
    ).toEqual([LOADER_CA_PEM.trim(), LOADER_LEAF_PEM.trim()]);
  });

  // R2-21 round-15 entrance B2: the blank separator line between RFC 1421
  // headers and the body is load-bearing. Without it the block fails to load
  // and the loader keeps NOTHING more from the rest of the file — measured
  // on Node v22.23.2: leaf + no-blank key block + root hands the workers the
  // leaf prefix alone while the blank-line twin above authorizes. The scan
  // therefore stops where the loader stops instead of counting the blocks
  // behind it and reporting zero gaps.
  const rfc1421WithoutBlankSeparator = RFC1421_ENCRYPTED_KEY.replace(
    'DEK-Info: AES-256-CBC,DF3B55948C8F8609B0D8D2F1FEB79878\n\n',
    'DEK-Info: AES-256-CBC,DF3B55948C8F8609B0D8D2F1FEB79878\n',
  );

  it('stops at a headered block missing its blank separator, keeping the prefix', () => {
    expect(
      extractCertificateBlocks(
        `${LEAF_PEM}${rfc1421WithoutBlankSeparator}${ROOT_PEM}`,
      ),
    ).toEqual([LEAF_PEM.trim()]);
  });

  it('takes nothing from a file starting with a separator-less headered block', () => {
    expect(
      extractCertificateBlocks(`${rfc1421WithoutBlankSeparator}${ROOT_PEM}`),
    ).toBeUndefined();
  });

  it('takes a legacy X509 CERTIFICATE-labelled block, rendered canonically', () => {
    // Oracle: authorized=true — OpenSSL's `PEM_STRING_X509_OLD` alias is a
    // certificate label the loader reads. Rejecting it dropped an operator
    // CA the workers would have trusted while warning, falsely, that the
    // file held no PEM certificate block Node can load. The merged bundle
    // this feeds is byte-stable, so the block comes back re-rendered under
    // the canonical label.
    const legacy = LOADER_CA_PEM.replace(
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN X509 CERTIFICATE-----',
    ).replace('-----END CERTIFICATE-----', '-----END X509 CERTIFICATE-----');
    expect(extractCertificateBlocks(legacy)).toEqual([LOADER_CA_PEM.trim()]);
  });

  it('takes a body whose final group carries non-zero unused pad bits', () => {
    // Oracle: authorized=true — the decoder ignores non-zero "unused" bits
    // in the final group, and the decoded bytes are byte-identical to the
    // canonical encoding (verified). The straight round-trip check rejected
    // this body and, breaking the scan, dropped every block after it.
    // `GQ==` -> `GR==` differs only in the four bits the decoder ignores.
    expect(LOADER_CA_PEM).toContain('GQ==');
    const mutated = LOADER_CA_PEM.replace('GQ==', 'GR==');
    const blocks = extractCertificateBlocks(mutated);
    expect(blocks).toHaveLength(1);
    expect(new X509Certificate(blocks![0]!).fingerprint256).toBe(
      new X509Certificate(LOADER_CA_PEM).fingerprint256,
    );
  });
});

describe('loadableCertificates', () => {
  it('parses every block it returns', () => {
    const certs = loadableCertificates(`${LEAF_PEM}${ROOT_PEM}`);
    expect(certs?.map((cert) => cert.subject)).toEqual([
      'CN=localhost',
      'CN=Probe Root CA',
    ]);
  });

  it('returns undefined when the loader would take nothing', () => {
    expect(loadableCertificates('not a certificate\n')).toBeUndefined();
  });
});
