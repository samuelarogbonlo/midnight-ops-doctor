# Security

## Reporting a vulnerability

For security-relevant findings, please don't open a public issue. Email the maintainer at `samuel.arogbonlo@p2p.org` with:

- A description of the issue and its impact.
- Steps to reproduce, ideally a minimal manifest or input that triggers it.
- Your contact handle (GitHub, email, X, whatever you prefer for follow-up).

You'll get an acknowledgement within 72 hours. Coordinated disclosure is preferred.

## Threat model

This bundle is documentation plus four diagnostic scripts. The interesting attack surface lives almost entirely in `scripts/deploy-verifier.mjs`, which reads a JSON manifest containing RPC URLs, contract addresses, and a path to a local `.zkey` file.

Hardening already applied:

- URL scheme whitelist (`http`, `https`, `ws`, `wss`). `file://`, `gopher://`, and similar are rejected before any `fetch()` call.
- The wallet diagnostics URL is pinned to loopback (`127.0.0.1`, `localhost`, `::1`) only.
- snarkjs is invoked via `child_process.execFile` with an argv array and `shell: false`. Path arguments cannot inject shell metacharacters.
- Manifest size capped at 64 KiB. The script refuses oversized input.
- EVM verifier addresses are regex-validated (`0x` + 40 hex). Midnight contract addresses are typeof-checked.
- vk byte-equality (Check 5) refuses to match scalars compressed to fewer than four bytes; this prevents a false-pass where a zero scalar's two-byte `PUSH1 0x00` needle matches nearly every contract's bytecode.
- Error messages going to stdout are scrubbed for absolute paths and operator URLs to reduce leakage in CI logs.

If you find a way around any of these, the script-level threat model wants to know.

## Out of scope

- The skill content (`SKILL.md`, `references/*.md`) is markdown read by AI agents. It contains no secrets and makes no network calls of its own.
- The other three scripts (`address-derive.mjs`, `rpc-reachability-probe.mjs`, `persistent-hash-self-test.mjs`) take only a small number of well-typed CLI arguments and don't read JSON manifests.

## Dependencies

Loaded dynamically with clear error messages when missing:

- `snarkjs` — for vk extraction in `deploy-verifier.mjs`.
- `ws` — for WebSocket probing in `rpc-reachability-probe.mjs`.

No transitive runtime dependencies beyond Node 20 standard library and these two optional packages. Audit them upstream as needed.

## Compromised local environment

If an attacker has write access to your local filesystem, they can replace `node_modules/.bin/snarkjs` with a malicious binary, modify the bundled scripts, or substitute your `.zkey`. None of this is in scope. Operate from a trusted machine.
