---
name: toolkit-guide
description: Gates for the toolkit_* tools. Use when checking a download checksum, webhook HMAC, or HS256 JWT with toolkit_hash_value; moving digest bytes between hex, base64, and base64url; or reading who runs an IP's network from toolkit_geolocate_ip. Also covers the operator-gated toolkit_check_network and toolkit_check_system. Read before reporting a mismatch, a down host, or an IP's owner, or when a task needs a host diagnostic missing from the tool list.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

- **Never compute these yourself.** A digest, HMAC, base64/hex conversion, or "random" ID that didn't come from a tool call or executed code is fabricated. Call the tool.
- **Files on disk.** With a shell and the file at hand, hash it there (`sha256sum`, `shasum -a 256`) instead of moving its bytes through a tool call.
- **Not covered:** RS/ES/PS/EdDSA signatures, JWT claim validation, choosing a line from a multi-line checksum file, reverse DNS, and registration (whois/RDAP) records such as abuse contacts.

**When a host diagnostic isn't listed,** tell the user it takes a local or self-hosted install with that tool's enable flag; the public hosted instance never lists toolkit_check_network or toolkit_check_system. Don't substitute toolkit_geolocate_ip: it queries a provider and never contacts the target, so it says nothing about reachability.

## Identifiers

What each check compares. `value` is the message, `expected` is the published digest or signature, and `secret` is the HMAC key.

| Check | `value` | `expected` | Settings |
|:--|:--|:--|:--|
| Download checksum | The file's bytes, as hex or base64 with matching `inputEncoding` | The published digest, or this file's single line from `sha256sum`, `shasum --tag`, or `openssl dgst`, or a `sha256:` reference | `algorithm` per the file name or prefix |
| GitHub webhook | Raw request body, byte for byte | `X-Hub-Signature-256` as sent (`sha256=…`) | `secret`: the webhook secret |
| Stripe webhook | `<t>.<raw body>`, with `t` from `Stripe-Signature` | Each `v1=` hex value, one compare apiece | `secret`: the endpoint signing secret |
| Slack request | `v0:<X-Slack-Request-Timestamp>:<raw body>` | `X-Slack-Signature` without its `v0=` | `secret`: the signing secret |
| HS256/HS384/HS512 JWT | `<segment 1>.<segment 2>` exactly as in the token | Segment 3 (base64url) | `algorithm` sha256/sha384/sha512 to match the header's `alg` |
| PKCE S256 challenge | The code_verifier | none: run `generate` | `digestEncoding` base64url |

Other published forms:

- npm `integrity` and Subresource Integrity are `sri`.
- `Content-MD5` and `x-amz-checksum-sha256` are base64.
- JWK members (`k`, `x`, `y`, `n`, `e`), JWS signatures, and PKCE challenges are unpadded base64url.

## Gates

### Digests and signatures

**`matches: false` only says these bytes don't hash to that digest.** Before reporting corruption, tampering, or a forged signature, rule out these input faults:

- a trailing newline or CRLF that the original didn't have
- JSON re-serialized or pretty-printed in place of the raw body
- binary sent as base64 or hex without the matching `inputEncoding`: the tool then hashes the encoded text
- a checksum line for a different file: the filename in the line is not checked
- a signing string other than the one in the table above

**Secret encoding.** A secret supplied as hex, base64, or base64url needs `secretEncoding`. Otherwise the HMAC is keyed on the text of the encoding.

**Pass only the signature token as `expected`.** The tool accepts `<algorithm>:` and `<algorithm>=` prefixes and a single checksum-file line. Strip other wrappers yourself: Stripe's `t=…,v1=` and Slack's `v0=`.

**Secrets travel to the server.** `secret` and `value` go to whichever server this connection reaches. On a remote instance, use a test secret, or ask the user before sending a production signing secret. A local install keeps the secret on the machine.

### Encoding

**To move bytes between encodings, decode from the source encoding with `outputEncoding` set to the target.** `encode` reads `value` as UTF-8 text, so encoding a hex digest to base64 returns the base64 of its 64 characters (88 characters long, not 44), and no error flags it.

**With the source data in hand, skip transcoding.** Generate the digest directly in the form the consumer takes (`digestEncoding` hex, base64, base64url, or sri).

### Geolocation

**A hostname yields one address.** The server's own DNS resolves a hostname to one address, reported as `resolvedIp`. CDN, anycast, and GeoDNS names resolve differently from different places. The result locates that one address as the server sees it, not where a site is hosted. `hosting: true` flags a datacenter address.

**"Who runs this network" has several answers:**

- `isp`, `asHolder` (the AS holder's name), and `asName` (the registry's AS name, such as `CLOUDFLARENET`) name the network operator, and `asn` is its number.
- `org` is often a customer or sub-allocation label. For 1.1.1.1 it reads "APNIC and Cloudflare DNS Resolver project".

Cite the field that answers the question asked.

### Host diagnostics

**Which machine "the server's host" is depends on the launch:**

- the user's machine, for a bunx/npx stdio install
- the container, for a Docker launch (its own hostname, interfaces, and memory limit)
- the remote host, for an HTTP deployment

**Don't call a host down on ping or traceroute alone.** Live hosts that drop ICMP commonly return ping `reachable: false`. Traceroute `*` hops are routers that didn't answer, not packet loss. Run toolkit_check_network `connectivity` on the port its service uses:

- `open` proves the address answered.
- `refused` normally means the host answered with nothing listening. A server running under Bun on macOS, however, also reports a connect with no route as `refused`.
- `timeout` and `unreachable` can't tell a stopped host from a filter or a broken route. Report what failed and from where, not that the host is off.

**`outcome: unreachable` is a connect result. An error with reason `unreachable` means no diagnosis ran.** A hostname that didn't resolve fails every mode, `connectivity` included: check its spelling or pass its IP address. Otherwise `ping` or `traceroute` gave no result: the binary is missing (the published Docker image ships neither), was stopped at its time limit, or exited with an error and no result. Fall back to `connectivity` on the service's port.

**`public_ip` can't speak to IPv6.** Its echo service has only an IPv4 address, so it reports the IPv4 egress address and can't show whether IPv6 egress works.

**Memory headroom is `availableBytes`, capped by `limitBytes` when present.** Under a container limit, reclaimable page cache counts as used, so the figure reads low rather than high.

### IDs and QR codes

**`uuid_v7` and `ulid` embed their creation time to the millisecond.** Use `uuid_v4` when an ID must not reveal when it was minted.

**To show a code in a chat, request `png_base64`.** It also arrives as an MCP image block. `svg` returns markup text.

## Workflows

### Verify an HS256 JWT

1. Split the token on `.` into three segments.
2. Decode segment 1 as base64url with toolkit_encode_value, and read `alg` from the header JSON.
   - HS256, HS384, or HS512 map to `algorithm` sha256, sha384, or sha512.
   - Stop on `none` or any asymmetric `alg`: this server can't verify it.
3. Run toolkit_hash_value `compare` with:
   - `value`: `<segment 1>.<segment 2>`, still encoded, exactly as in the token
   - `secret`: the shared key (for a JWK, its `k` with `secretEncoding` base64url)
   - `expected`: segment 3

   Never HMAC the decoded JSON.
4. `matches: true` proves the signature only. Decode segment 2 the same way and check `exp`, `nbf`, `aud`, and `iss` yourself. `exp` and `nbf` are seconds since the epoch.

### Is the host down, or is it IPv6?

1. Run toolkit_check_network `connectivity` on the service's port twice: once with `family` 4, once with `family` 6. `resolvedIp` names the address whose result came back.
2. A `family_mismatch` error for `family` 6 means the server's resolver returned no IPv6 address for the name. That isn't a host failure.
3. If IPv4 is `open` and IPv6 isn't, the host is up and the IPv6 path is at fault.
4. To tell the host's IPv6 from the server's own, probe a known-good IPv6 literal (for example `2606:4700:4700::1111` on port 443). If that also fails, the server's IPv6 egress is broken.
5. Without `family`, `connectivity` moves through the hostname's addresses until one opens, and stops at the first that times out. An `open` result then doesn't show that both families work. Read `resolvedIp`.
