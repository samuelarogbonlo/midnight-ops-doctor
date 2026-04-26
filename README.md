# midnight-ops-doctor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Works in Claude Code · Codex · Cursor](https://img.shields.io/badge/works%20in-Claude%20Code%20·%20Codex%20·%20Cursor-blue)](#install)
[![Status: v0.1.0](https://img.shields.io/badge/status-v0.1.0-green)](CHANGELOG.md)

midnight-ops-doctor is a skill that turns Claude (or Codex, Cursor, any markdown-reading agent) into a [Midnight Network](https://midnight.network/) operations expert. Birthed from running a cross-chain shielded-swap protocol on Midnight in production — every entry came from hitting a wall, climbing it, and writing down what worked.

## Why this exists

Given that Midnight is a growing ecosystem, this skill is built to solve:

- The wallet sync trap: `Custom error: 139` from submitting before sync completes.
- The `deployContract()` hang — SDK helper with no timeout, replaced by a six-phase manual flow.
- Three-address confusion: one seed gives three addresses, and `getWalletAddress()` returns the wrong one for most operations.
- AWS infra in the way: ELB blocking cloud-IP traffic on preprod RPC (HTTP 403), WAF silently dropping POST bodies above 8KB (kills deploy txs). Both have workarounds bundled.
- DUST registration mechanics: DUST is not transferable; `dustReceiverAddress` is the only redirect path.
- `persistentHash` vs Node SHA-256 parity for cross-family HTLCs (Midnight ↔ EVM).
- Groth16 verifier vk drift between local zkey and on-chain bytecode — the bug class that lost real funds at FOOM Club and Veil Protocol.
- ESM-only `@midnight-ntwrk/*` packages crashing CJS backends with `ERR_UNSUPPORTED_DIR_IMPORT`.

And more as the ecosystem expands.

## Install

In Claude Code, symlink and restart:

```bash
ln -s "$(pwd)/midnight-ops-doctor" ~/.claude/skills/midnight-ops-doctor
```

In any other agent (Codex, Cursor, Cline, Aider, Claude API): point the agent at `SKILL.md` as a project instruction file. Scripts run with `node` directly, no Claude-specific dependencies.

## Verify it's wired up

After installing, paste this into a fresh Claude session:

> My Midnight wallet is stuck syncing at 47%, appliedIndex isn't moving.

Expected response: Claude routes you to `references/wallet-lifecycle.md` § Sync stalls within one turn, with a code snippet that gates submission on `isStrictlyComplete`. If activation fires but the wrong doc loads, the frontmatter triggers need tuning. Open an issue.

Two more verification prompts you can try:

> I'm getting 403 from rpc.preprod.midnight.network on a GCP VM.

Expected: routes to `references/network-chooser.md` § Cloud-IP block, identifies AWS ELB (not Cloudflare), points at the bundled Cloudflare Worker template.

> How do I verify my deployed Groth16 SettlementVerifier actually matches my local zkey?

Expected: offers to run `scripts/deploy-verifier.mjs` against your manifest; on FAIL routes to `references/groth16-vk-mismatch.md` for incident response.

## The deploy verifier

The one script worth singling out. Catches the bug where your local `.zkey` and your deployed Groth16 verifier don't match. Same bug class that lost funds at FOOM Club and Veil Protocol.

```bash
node scripts/deploy-verifier.mjs assets/deploy-manifest.example.json
```

The bundled manifest is a placeholder template. Fill in your own deployment values before running. For private real-address validation, drop a `deploy-manifest.local.json` next to it (gitignored).

If the verifier reports `vk byte-equality FAIL`, read `references/groth16-vk-mismatch.md`. That doc walks through the incident response: how to identify the canonical zkey, choose between redeploying the verifier and restoring the local zkey, communicate to users with locked funds, and prevent recurrence.

## What's in here

- `SKILL.md` — entry point. A triage table that maps a symptom to a runbook.
- `references/` — eight runbooks: three-address model, wallet lifecycle, network chooser, DUST registration, cross-family hashlocks, symptom catalog (twenty indexed errors), version compatibility, Groth16 vk-mismatch playbook.
- `scripts/` — four diagnostics:
  - `address-derive.mjs <seed>` derives all three Midnight addresses
  - `rpc-reachability-probe.mjs <wss-url>` checks if a Midnight RPC is reachable from this machine
  - `persistent-hash-self-test.mjs` confirms `persistentHash` matches Node SHA-256 on golden vectors
  - `deploy-verifier.mjs <manifest.json>` runs a seven-check post-deploy smoke test
- `assets/` — Cloudflare worker template for cloud RPC blocks, and the example manifest for the deploy verifier.

## Validation

- 12 real symptoms tested end-to-end. Each routes to the right runbook with a runnable fix.
- 4 scripts sanity-checked. The deploy verifier was tested against a live Arbitrum Sepolia + Midnight preview deployment.
- Security review on the deploy verifier fixed 9 issues. See `SECURITY.md`.
- Battle-tested in production on a cross-chain shielded-swap protocol on Midnight.

## License

MIT. See `LICENSE`.
