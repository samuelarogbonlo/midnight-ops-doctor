# Changelog

All notable changes to this project will be documented here.

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
