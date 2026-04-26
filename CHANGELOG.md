# Changelog

All notable changes to this project will be documented here.

## 0.1.1

Hardening pass on the deploy verifier and the Cloudflare Worker template, prompted by a second review on top of the original security pass.

### Fixed

- **Deploy verifier (`scripts/deploy-verifier.mjs`):**
  - `manifest.evm.chainId === 0` no longer silently disables the chain-ID guard. The loader now rejects `0` and any non-positive integer at parse time.
  - Temp directory created by the snarkjs vk-export call is now cleaned up via `try/finally`. Previously every run left a `/tmp/deploy-verifier-XXXXXX/` directory behind.
  - SSRF defence-in-depth: `manifest.midnight.indexerUrl` and `manifest.midnight.rpcUrl` now reject hostnames resolving to private/loopback/link-local IP space (RFC 1918, 169.254.0.0/16 incl. AWS IMDS, ::1, fe80::/10, fc00::/7). Operators running an internal mirror can opt out with `MIDNIGHT_ALLOW_PRIVATE_NETWORK=1`. Wallet diagnostics URL stays loopback-required; proof-server and EVM RPC are unrestricted (local Anvil / docker proof-server are common).
  - Unknown top-level manifest keys now emit a `WARN` to stderr. Catches `_proofServer_diabled`-style typos that previously left a section silently disabled.
  - `tDUST` balance display is now BigInt-aware. Avoids `Number` precision loss above `2^53` base units (theoretical only; pre-emptive for mainnet).
  - Node 20+ is enforced at runtime with a clear error. `node:dns/promises`, `AbortSignal.timeout`, and `fetch()` all assume it.
  - Added a comment block on `checkVkByteEquality` documenting its three load-bearing assumptions: snarkjs default codegen, deterministic IC[] order, bn128/groth16.

- **Cloudflare Worker template (`assets/cloudflare-worker-template/`):**
  - Added `package.json`, `tsconfig.json`, and `.gitignore`. The directory was previously incomplete to ship — `wrangler deploy` failed with `TS2339: Property 'webSocket' does not exist on type 'Response'` because `@cloudflare/workers-types` was not in scope.
  - Header strip: `cf-*` prefix-strip plus explicit `forwarded`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-port`, `x-real-ip`. Previously leaked the original client IP and CF geo-enrichment headers (`cf-ipcity`, `cf-ipasn`, etc.) to the Substrate node.
  - WebSocket sessions now have a 60-second idle timeout. An idle client could previously pin a Worker session until CF's wall-clock cap.
  - `/__canary` now probes upstream via JSON-RPC `system_chain` POST instead of bare GET. Robust against the upstream changing its default-page status code (previously keyed on exactly `405`).
  - `safeClose` remap extended to cover all four reserved RFC 6455 close codes (1004, 1005, 1006, 1015).

- **Manifest example (`assets/deploy-manifest.example.json`):**
  - Clarified that `expectedGenesisHash` is a network constant, not a placeholder. New `_expectedGenesisHash_comment` documents lookup paths for preprod / mainnet.
  - `chainId` example value is now `421614` (Arbitrum Sepolia) instead of `0`. The verifier now rejects `0` so the previous default would fail at load time anyway.
  - `_chainId_comment` documents that the field is required and that `0` is rejected.

### Security

- The verifier's threat-model section in `SECURITY.md` updated with the new hardening (private-IP denylist, manifest-key warning, chainId guard, temp cleanup, Node version enforcement).

## 0.1.0

Initial release.

### Added

- `SKILL.md` entry point with a triage table mapping twelve high-frequency Midnight backend symptoms to runbooks.
- Eight reference docs:
  - `three-addresses.md` — one-seed-three-roles mental model + derivation code.
  - `wallet-lifecycle.md` — init, sync, six-phase manual deploy, AWS WAF 8KB workaround, snapshot save/restore.
  - `network-chooser.md` — preview/preprod/local/mainnet selection + Cloudflare Worker reverse-proxy for cloud-IP RPC blocks.
  - `dust-night-registration.md` — `dustReceiverAddress` mechanics, ~12hr accrual timeline, Lace bootstrap.
  - `cross-family-hashlocks.md` — `persistentHash(CompactTypeBytes(32), bytes)` parity with Node SHA-256 + golden vectors.
  - `symptom-catalog.md` — twenty indexed errors with copy-paste fixes.
  - `version-matrix.md` — proof-server / ledger / wallet-sdk / contracts / Compact compatibility table.
  - `groth16-vk-mismatch.md` — incident playbook for vk byte-equality FAIL.
- Four diagnostic scripts:
  - `address-derive.mjs` — derive Zswap / NightExternal / Dust addresses from a seed or mnemonic.
  - `rpc-reachability-probe.mjs` — diagnose AWS ELB, DNS, TLS, and timeout failure modes.
  - `persistent-hash-self-test.mjs` — golden-vector SHA-256 parity check.
  - `deploy-verifier.mjs` — seven-check post-deploy smoke test (wallet sync, proof-server version, genesis hash, contract resolution, on-chain Groth16 vk byte-equality, RPC reachability, DUST balance).
- `assets/cloudflare-worker-template/` — ready-to-deploy Worker for cloud-IP RPC blocks.
- `assets/deploy-manifest.example.json` — schema template for the deploy verifier.

### Validation

- Twelve acceptance scenarios pass via static review and live script tests.
- Security pass on `deploy-verifier.mjs` fixed nine issues including shell injection in the snarkjs wrapper, false-pass on short vk scalars, SSRF via non-HTTP URL schemes, and token exfiltration via attacker-controlled diagnostics URL. See `SECURITY.md`.
- All `--help` flags exit zero, bad inputs exit non-zero with clean errors.
- The deploy verifier was tested end-to-end against a real Arbitrum Sepolia + Midnight preview deployment (positive case passes; negative case pointed at a known-stale verifier fails Check 5 with the specific scalar mismatch).

### Cross-platform

- Native auto-trigger via SKILL.md frontmatter in Claude Code and Claude Desktop.
- Manual installation in Codex / Cursor / Cline / Aider / Claude API by reading `SKILL.md` as a project instruction file. Scripts run with `node` directly.
