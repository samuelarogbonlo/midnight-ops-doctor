# midnight-network-dev

Notes from running a Midnight Network backend in production. Symptom on the left, fix on the right. Set up as a Claude Code skill, but the content reads fine as a plain reference if you read it directly.

## What's in here

- `SKILL.md` — entry point. A triage table that maps a symptom to a runbook.
- `references/` — eight runbooks: three-address model, wallet lifecycle, network chooser, DUST registration, cross-family hashlocks, symptom catalog (twenty indexed errors), version compatibility, Groth16 vk-mismatch playbook.
- `scripts/` — four diagnostics:
  - `address-derive.mjs <seed>` derives all three Midnight addresses
  - `rpc-reachability-probe.mjs <wss-url>` checks if a Midnight RPC is reachable from this machine
  - `persistent-hash-self-test.mjs` confirms `persistentHash` matches Node SHA-256 on golden vectors
  - `deploy-verifier.mjs <manifest.json>` runs a seven-check post-deploy smoke test
- `assets/` — Cloudflare worker template for cloud RPC blocks, and the example manifest for the deploy verifier.

## Using it

In Claude Code, symlink and restart:

```bash
ln -s "$(pwd)/midnight-network-dev" ~/.claude/skills/midnight-network-dev
```

In any other agent (Codex, Cursor, Cline, Aider, Claude API): point the agent at `SKILL.md` as a project instruction file. Scripts run with `node` directly, no Claude-specific dependencies.

## The deploy verifier

The one script worth singling out. Catches the bug where your local `.zkey` and your deployed Groth16 verifier don't match. Same bug class that lost funds at FOOM Club and Veil Protocol.

```bash
node scripts/deploy-verifier.mjs assets/deploy-manifest.example.json
```

The bundled manifest is a placeholder template. Fill in your own deployment values before running. For private real-address validation, drop a `deploy-manifest.local.json` next to it (gitignored).

If the verifier reports `vk byte-equality FAIL`, read `references/groth16-vk-mismatch.md`. That doc walks through the incident response: how to identify the canonical zkey, choose between redeploying the verifier and restoring the local zkey, communicate to users with locked funds, and prevent recurrence.

## Validation

- Twelve acceptance scenarios pass: each routes a verbatim user symptom through the SKILL.md decision tree to a runbook with a runnable fix.
- Scripts are sanity-checked: `--help` exits zero, bad inputs exit non-zero with clean errors, the persistent-hash self-test passes Node SHA-256 baselines, the deploy verifier was tested end-to-end against a real Arbitrum Sepolia + Midnight preview deployment (positive case passes; negative case pointed at a known-stale verifier fails Check 5 with the specific scalar mismatch).
- A security pass on `deploy-verifier.mjs` fixed nine issues including shell injection in the snarkjs wrapper, false-pass on short vk scalars (a zero scalar produced a two-byte needle that matches nearly every contract), SSRF via `file://` URLs, and token leakage in error messages.

## Where this came from

Built from running a cross-chain shielded-swap protocol on Midnight. Every fix in here came from hitting a wall, climbing it, and writing down what worked. The reference implementation is one specific codebase. The patterns transfer to any Midnight backend.

## License

MIT. See `LICENSE`.
