---
name: midnight-ops-doctor
description: Diagnostic playbook for Midnight Network backend ops. Triggers on wallet sync stalls (appliedIndex, isStrictlyComplete, Custom error 139), deploy hangs (deployContract, watchForTxData), three-address confusion (Zswap coinPublicKey, NightExternal bech32m, Dust publicKey), DUST zero-balance and registerNightUtxosForDustGeneration, cloud-IP RPC 403 from AWS ELB on GCP/DO/AWS, AWS WAF 8KB submitTx (use wallet.submitTransaction), Turnstile faucet errors, persistentHash vs SHA256 hashlock mismatches in EVM-Midnight HTLCs, proof-server version drift (ledger-v7/v8), Groth16 verifier vk mismatches (SettlementVerifier, settlement_proof_final.zkey), @midnight-ntwrk ESM import errors (ERR_UNSUPPORTED_DIR_IMPORT, wallet-sdk-facade), NIGHT/tNIGHT backend funding. Does NOT trigger for Compact syntax (sealed, disclose, witness), circuit/contract authoring, or compiler install — route to ADAvault or midnight-mcp. Does NOT trigger for generic ZK theory, generic Solidity/viem bugs, generic 403, tokenomics, or browser Lace UI.
license: MIT
---

# midnight-ops-doctor

Notes from running a Midnight Network backend in production. Look up your symptom in the triage table, follow the link to the runbook.

---

## Triage

Match the user's words against the left column. Load only the doc on the right. Don't pre-load others.

| Dev says... | Load |
|---|---|
| "stuck at X%", "wallet not syncing", "appliedIndex", "isStrictlyComplete" | `references/wallet-lifecycle.md` § Sync stalls |
| "Custom error: 139", "transaction rejected by node", "Invalid Transaction" | `references/symptom-catalog.md` § err-139 |
| "deployContract hangs", "watchForTxData never returns", "deploy timed out" | `references/wallet-lifecycle.md` § Six-phase deploy |
| "403", "WAF", "ELB", "blocked from my server", "GCP/AWS/DO + Midnight" | `references/network-chooser.md` § Cloud-IP block |
| "wrong address", "faucet didn't arrive", "balance shows 0", "which address" | `references/three-addresses.md` |
| "DUST", "NIGHT registration", "dust generation", "dustReceiverAddress", "tDUST" | `references/dust-night-registration.md` |
| "verifier returns false", "vk mismatch", "Groth16 deploy verification" | run `scripts/deploy-verifier.mjs`; for incident response read `references/groth16-vk-mismatch.md` |
| "persistentHash", "SHA256 doesn't match", "hashlock mismatch", "cross-family" | `references/cross-family-hashlocks.md` |
| "ERR_UNSUPPORTED_DIR_IMPORT", "ESM in CJS", "@midnight-ntwrk import fails" | `references/symptom-catalog.md` § cjs-esm |
| "submitTx timeout", "tx >8KB fails", "AWS WAF on RPC" | `references/symptom-catalog.md` § waf-8kb |
| "snapshot won't restore", "GCS scope", "wallet warm-restart broken" | `references/symptom-catalog.md` § snapshot-gcs |
| "what proof-server version", "ledger-v7 vs v8", "SDK compat" | `references/version-matrix.md` |

Routing rules:
- One symptom, one doc. Never broadcast-load.
- If the user describes two symptoms, fix the one that blocks the other first (sync before deploy, network before sync).
- If no row matches, ask one clarifying question. Don't guess.

---

## Three addresses

The single most-mis-applied concept in Midnight backend code. Inline here so triage doesn't require loading a reference doc.

### One seed, three addresses

A single `MIDNIGHT_SEED` (32-byte or 64-byte hex) derives **three distinct addresses** through `HDWallet.fromSeed(seed).selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0)`. The roles enum is exported by `@midnight-ntwrk/wallet-sdk-hd`. Each role yields a separate keypair with a different on-chain semantic.

```typescript
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import {
  ZswapSecretKeys,
  DustSecretKey,
} from '@midnight-ntwrk/ledger-v8';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-address-format';
import { MidnightBech32m, DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

const seed = Buffer.from(process.env.MIDNIGHT_SEED!, 'hex');
const hd = HDWallet.fromSeed(new Uint8Array(seed));
if (hd.type !== 'seedOk') throw new Error(`HD seed failed: ${hd.type}`);

const derived = hd.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
  .deriveKeysAt(0);
if (derived.type !== 'keysDerived') throw new Error(`derive failed: ${derived.type}`);

const networkId = 'preview'; // or 'preprod' / 'mainnet'

const zswapKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
const dustSecret = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
const unshieldedKs = createKeystore(derived.keys[Roles.NightExternal], networkId);

const shieldedCoinPublicKey = zswapKeys.coinPublicKey;                     // 32-byte hex
const unshieldedAddress = unshieldedKs.getBech32Address().toString();      // mn_addr_<net>1...
const dustAddress = MidnightBech32m
  .encode(networkId, new DustAddress(dustSecret.publicKey))
  .toString();                                                             // mn_dust_<net>1...

hd.hdWallet.clear();
```

### Address shapes

| Role | Format | Example |
|---|---|---|
| `Roles.Zswap` | 32-byte hex (no prefix in SDK; backend pads to `0x` + 64 hex) | `4f1c...3a9b` |
| `Roles.NightExternal` | bech32m | `mn_addr_preview1qwerty...` / `mn_addr_preprod1...` |
| `Roles.Dust` | bech32m | `mn_dust_preview1...` / `mn_dust_preprod1...` |

### Operation, address, why

| Operation | Use this address | Why |
|---|---|---|
| Faucet POST `address` field | unshielded bech32m | Faucet drops land in the unshielded UTXO set |
| Lace "Receive" tab display | unshielded bech32m | Lace's UI is unshielded-default |
| Indexer balance query | unshielded bech32m | Public chain state is keyed on unshielded |
| Native NIGHT transfer (send) | unshielded bech32m | NIGHT lives unshielded |
| Shielded zswap tx, `coinPublicKey` API params | shielded hex (Zswap) | Shielded ledger uses coin public keys |
| HTLC `sender` / `receiver` Bytes<32> arg | shielded hex (Zswap) | HTLC contract takes raw 32-byte keys |
| DUST balance lookup, dust-credit recipient | dust bech32m | Dust accrual uses the dust public key |
| `dustReceiverAddress` arg to `registerNightUtxosForDustGeneration` | dust bech32m | Designation targets the dust address |

### The `getWalletAddress()` trap

Many wallet adapter wrappers expose a `getWalletAddress()` method that returns ONLY the shielded coin public key (32-byte hex padded to `0x` + 64 hex). Backend code that says "the wallet address" almost always means this one. It's correct for HTLC `sender`/`receiver` args, and wrong for everything balance-related (faucet, Lace, indexer).

When in doubt, expose all three on a diagnostics endpoint and pick by use case:

```typescript
{
  shieldedCoinPublicKey: '0x4f1c...3a9b',
  unshieldedAddress: 'mn_addr_preview1...',
  dustAddress: 'mn_dust_preview1...',
}
```

### Seed normalization gotcha

A 24-word BIP39 mnemonic can be normalized into a seed three ways. Only one matches Lace.

| Normalization | Bytes | Matches Lace? |
|---|---|---|
| `bip39.mnemonicToSeedSync(mnemonic, '')` (PBKDF2 full) | 64 | YES |
| First 32 of PBKDF2 output | 32 | NO |
| `bip39.mnemonicToEntropy()` (BIP39 entropy) | 32 | NO |

If your derived addresses don't match what Lace shows, you almost certainly used the wrong normalization. The bundled `scripts/address-derive.mjs` runs the canonical PBKDF2-full path.

For deeper diagnostics (faucet didn't arrive, balance still zero, address mismatch), load `references/three-addresses.md`.

---

## Quick fixes

Top twelve errors. One-line diagnosis, minimum-viable fix. If the fix doesn't stick, escalate to the deeper doc.

### `Custom error: 139`

Diagnosis: wallet submitted a transaction before chain sync completed. Node rejected stale UTXO inputs.

Fix:
```typescript
await waitForWalletSyncState(WALLET_SYNC_TIMEOUT_MS, 'startup');
// only then: submitTx, deploy, lock, etc.
```

Deeper: `references/wallet-lifecycle.md` § Sync-completion check.

### `ERR_UNSUPPORTED_DIR_IMPORT` from `@midnight-ntwrk/*`

Diagnosis: `@midnight-ntwrk/*` packages are ESM-only. CJS `require()` fails on bare-directory imports.

Fix:
```typescript
// In a CJS file, use type-only static imports + dynamic import for runtime.
import type { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
const { WalletFacade } = await import('@midnight-ntwrk/wallet-sdk-facade');
```

Deeper: `references/symptom-catalog.md` § cjs-esm.

### `submitTx` times out around 25-30s, tx is ~90 KB

Diagnosis: the SDK's HTTP `submitTx` posts to RPC. AWS WAF rejects bodies >8 KB. Deploy txs are typically 50-100 KB.

Fix: route submission through `wallet.submitTransaction(tx)`. That uses the WebSocket relay (PolkadotNodeClient), bypassing the HTTP body limit.

```typescript
const midnightProvider = {
  async submitTx(tx) { return wallet.submitTransaction(tx); },
};
```

Deeper: `references/symptom-catalog.md` § waf-8kb.

### `403 Forbidden` from `https://rpc.preprod.midnight.network` (only on cloud VMs)

Diagnosis: AWS ELB on the preprod RPC blocks cloud-provider IP ranges (GCP, DO, AWS, etc.). `server: awselb/2.0` in the response headers confirms it. Indexer is unblocked. Only RPC is.

Fix: prefer **preview** network (typically reachable from cloud VMs; verify with `scripts/rpc-reachability-probe.mjs`) or run a Cloudflare Worker reverse-proxy from `assets/cloudflare-worker-template/`.

```bash
# preview env
MIDNIGHT_NETWORK_ID=preview
MIDNIGHT_NODE_RPC=wss://rpc.preview.midnight.network
MIDNIGHT_INDEXER_URL=https://indexer.preview.midnight.network/api/v3/graphql
```

Deeper: `references/network-chooser.md` § Cloud-IP block.

### `deployContract()` hangs forever (no logs, no progress)

Diagnosis: the SDK's `deployContract()` calls `watchForTxData()` internally with no timeout. If the tx never lands on-chain, it waits indefinitely.

Fix: don't use `deployContract()`. Use the six-phase manual flow with explicit timeouts on each phase.

```typescript
const unproven = await createUnprovenDeployTx(providers, { compiledContract, ... });
const proven = await providers.proofProvider.proveTx(unproven.private.unprovenTx);
const balanced = await walletProvider.balanceTx(proven);
const txId = await wallet.submitTransaction(balanced);
const finalized = await Promise.race([
  publicDataProvider.watchForTxData(txId),
  new Promise((_, r) => setTimeout(() => r(new Error('confirm timeout')), 90_000)),
]);
```

Deeper: `references/wallet-lifecycle.md` § Six-phase deploy.

### Faucet POST succeeded but balance is still zero

Diagnosis: faucet was sent to the wrong address (probably the shielded hex from `getWalletAddress()` instead of the unshielded bech32m).

Fix:
```bash
curl -H "x-midnight-sidecar-token: $TOKEN" http://127.0.0.1:8090/wallet/diagnostics | jq
# verify addresses.unshieldedAddress matches the address you sent to
```

Deeper: `references/three-addresses.md` § Diagnostic recipes.

### Wallet sync stuck >30 min on a fresh container

Diagnosis: cold sync on preprod is genuinely slow. Linear in chain depth, no birthday/fast-sync primitive. Preview is faster (~20 min).

Fix: wait. If still stuck after 60 min, check indexer reachability and the dust sub-wallet specifically. Dust is usually the bottleneck.

Deeper: `references/wallet-lifecycle.md` § Cold-sync expectations.

### Dust balance is zero after sync completes

Diagnosis: the wallet has NIGHT but `registerNightUtxosForDustGeneration` was never called. There is no programmatic faucet for DUST.

Fix: open the same seed/mnemonic in **Lace wallet** → Midnight tab → tNIGHT Designation. Lace can run the registration even with zero existing dust (works on preview, preprod is intermittent). Backend inherits the on-chain designation automatically; first dust appears in ~90 seconds.

Deeper: `references/dust-night-registration.md`.

### `persistentHash` output doesn't match Node `crypto.createHash('sha256')`

Diagnosis: you called `persistentHash(rawBytes)` instead of `persistentHash(new CompactTypeBytes(32), rawBytes)`. Compact's persistent hash requires a type tag. Without it the hash is a different domain.

Fix:
```typescript
import { persistentHash, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';
const bytesType = new CompactTypeBytes(32);
const hashlock = persistentHash(bytesType, preimage);  // matches sha256(preimage)
```

Deeper: `references/cross-family-hashlocks.md`.

### Snapshot upload fails with "Provided scope(s) are not authorized"

Diagnosis: GCE VM's default service account scopes include `devstorage.read_only` but not `read_write`. Local snapshot still works. Only GCS upload fails.

Fix:
```bash
gcloud compute instances stop <your-instance> --zone=<zone>
gcloud compute instances set-service-account <your-instance> \
  --zone=<zone> \
  --scopes=devstorage.read_write,logging-write,monitoring-write
gcloud compute instances start <your-instance> --zone=<zone>
```

Deeper: `references/symptom-catalog.md` § snapshot-gcs.

### Proof-server returns "version mismatch", or proofs verify locally but reject on-chain

Diagnosis: the proof-server image version, the ledger version (`ledger-v7` vs `ledger-v8`), and the on-chain Groth16 verifier's vk all need to match. One drift gives silent verification failure.

Fix: check `references/version-matrix.md` for the pinned compat row. Re-run `scripts/deploy-verifier.mjs` to confirm the on-chain vk matches your local zkey.

Deeper: `references/version-matrix.md`, `references/symptom-catalog.md` § err-vk-mismatch, and `references/groth16-vk-mismatch.md` (incident playbook if the script reports vk byte-equality FAIL).

### Lace shows "Failed to clone intent" when signing

Diagnosis: Lace wallet state race. Usually multiple tabs or a pending intent from a prior session.

Fix: close all Lace tabs except one, wait until Lace shows "Idle" status, retry. Not a protocol-level error.

Deeper: `references/symptom-catalog.md` § lace-clone-failure.

---

## Reference docs at a glance

Brief overviews. Load the matching reference for full runbooks.

### Three addresses (`references/three-addresses.md`)

One seed gives Zswap shielded hex, NightExternal unshielded bech32m, and Dust bech32m. `getWalletAddress()` returns only the shielded hex; backend code referring to "the address" is usually wrong for unshielded ops. Faucet drops, Lace Receive, indexer queries all use the unshielded bech32m. Load this when balance/faucet/which-address questions come up.

### Wallet lifecycle (`references/wallet-lifecycle.md`)

`WalletFacade.init()` builds the facade; `wallet.start(shieldedSecretKeys, dustSecretKey)` is a separate explicit step in SDK 3.x. Sync completion requires `appliedId >= highestTransactionId` AND `isStrictlyComplete: true` per sub-wallet. Submitting before that yields `Custom error: 139`. Deploy must use the six-phase manual flow because the SDK's `deployContract()` hangs forever on `watchForTxData`. Load this for any sync, deploy, submit, or warm-restart issue.

### Network chooser (`references/network-chooser.md`)

Preview vs preprod vs local-playground vs mainnet selection. Cloud VMs (GCP/DO/AWS) hit `awselb/2.0` 403 on preprod RPC. Preview is typically reachable from cloud VMs (verify with `scripts/rpc-reachability-probe.mjs` before relying on it). Cloudflare Worker reverse-proxy in `assets/cloudflare-worker-template/` is the workaround for preprod-only deployments. Load this for any "blocked from my server" or "which network should I use" question.

### DUST + NIGHT registration (`references/dust-night-registration.md`)

DUST is not transferable. Only redirectable via `dustReceiverAddress` during `registerNightUtxosForDustGeneration`. Fresh wallets bootstrap dust through Lace's tNIGHT Designation flow. About 12 hours for full ramp, ~90s for first dust to appear. Load this for "DUST balance zero", "how do I send DUST", or "registerNightUtxosForDustGeneration fails with InsufficientDust" questions.

### Cross-family hashlocks (`references/cross-family-hashlocks.md`)

Midnight's `persistentHash(CompactTypeBytes(32), bytes)` matches Node SHA-256 byte-for-byte ONLY with the type tag. Cross-family swaps (Midnight ↔ EVM SHA-256 corridor) require both sides compute the same hashlock from the same preimage. The bundled self-test (`scripts/persistent-hash-self-test.mjs`) confirms parity. Load this when hashlock parity, EVM/Midnight preimage matching, or persistentHash output is in question.

---

## The deploy verifier

`scripts/deploy-verifier.mjs` is the post-deploy smoke test. Run it after every Midnight HTLC deploy and before any go-live cutover.

### When to run

- Immediately after the deploy script reports a contract address.
- Before pointing the backend at a new contract address.
- After a network migration (preprod ↔ preview).
- As a CI gate before promoting an env file.

### Invocation

```bash
node scripts/deploy-verifier.mjs assets/deploy-manifest.example.json
```

The manifest shape is documented inline in `assets/deploy-manifest.example.json`. Required fields: `contractAddress`, `networkId`, `indexerUrl`, `nodeRpcUrl`, `expectedZkeyDigest`, `expectedVerifierAddress` (EVM side, when applicable).

### The seven checks

1. Indexer reachability — single GraphQL probe, 5s timeout.
2. Node RPC reachability — WebSocket handshake, no submission.
3. Contract address resolves on indexer — `contracts(offset: { address })` returns one row.
4. Contract genesis tx confirmed `SucceedEntirely`.
5. Local zkey SHA-256 matches `expectedZkeyDigest`.
6. On-chain Groth16 verifier vk hash matches the local zkey vk hash (cross-family corridor only).
7. `persistentHash` self-test against golden vector (`0x00...00` 32 bytes + `0xff...ff` 32 bytes).

### Exit codes

- `0` if all seven pass.
- non-zero (1-7) for the first failing check index.

Each failure line includes a one-line diagnosis and a pointer back to the relevant reference doc.

---

## Helper scripts

Bundled diagnostics under `scripts/`. All are pure Node.js, no extra deps beyond standard library + optional `ws` and `snarkjs` (clearly flagged when needed).

- `address-derive.mjs <seed-hex-or-mnemonic>` — derive all three addresses from a seed or mnemonic. Use when an address is suspect or when migrating to a new seed. Exits non-zero on derivation failure.
  ```bash
  node scripts/address-derive.mjs --mnemonic "regular all limb potato ..."
  node scripts/address-derive.mjs --seed 5ec6f3...8a (64 or 128 hex chars)
  ```

- `rpc-reachability-probe.mjs <wss-url>` — probe an RPC endpoint, log response headers, classify the failure mode (cloud-IP block via ELB, DNS, TLS, plain timeout). Use when "403 from my server".
  ```bash
  node scripts/rpc-reachability-probe.mjs wss://rpc.preprod.midnight.network
  ```

- `persistent-hash-self-test.mjs` — golden-vector check that your local `persistentHash(CompactTypeBytes(32), ...)` output matches Node `sha256`. Use when cross-family hashlocks don't match.
  ```bash
  node scripts/persistent-hash-self-test.mjs
  ```

---

## Self-improvement

When you hit something not covered here, capture it. The bundle gets better when each fix that works gets written down.

### Add a new symptom to `references/symptom-catalog.md`

After the user confirms a fix worked, append an entry in the existing format:

```
## err-<short-id>: <verbatim error string>

**Diagnosis:** <1-2 sentences>

**Fix:**
```<lang>
<runnable code or commands>
```

**Related:** <cross-link to relevant entry or reference doc>
```

If the symptom warrants more than ~30 lines of explanation, create a new `references/<topic>.md` file in the same shape as the existing ones (callout, contents, numbered sections, "see also") and link it from the triage table at the top of this file.

### When the user corrects an answer

Apply the correction, update the relevant doc, and if a domain rule emerged ("never do X in this context", "always check Y first"), add it to that doc's "Common failure modes" section.

### What not to persist

Update the bundle only for new symptoms, confirmed fixes, and explicit user-stated rules. Don't update for cosmetic preferences, single anecdotes, or speculation.

### One change per commit

Three new symptoms in one session: three separate symptom-catalog entries, not one merged blob. The history stays reviewable.

---

## Using this in other agents

This is built as a Claude Code skill. The content also works in any agent that can read markdown and run Node.js scripts.

| Agent | Activation |
|---|---|
| Claude Code (CLI + IDE) | Symlink the bundle into `~/.claude/skills/midnight-ops-doctor/`. Frontmatter triggers on Midnight symptoms. |
| Claude Desktop / claude.ai | Upload as a Skill via Settings → Capabilities. Frontmatter triggers natively. |
| Claude API | Include `SKILL.md` as part of a system prompt. Pre-bundle deps; the API sandbox has no runtime install. |
| Codex / Cursor / Cline / Aider | Point the agent at `SKILL.md` as a project instruction file (e.g., `cp SKILL.md ./AGENTS.md`). Scripts run with `node` directly. |

The diagnostic content, runbooks, and scripts are the same across platforms. What's not portable is the YAML frontmatter — only Claude Code and claude.ai parse it for auto-discovery.

---

## Out of scope

This is operational, not pedagogical or generative. Delegate the following.

- Compact language syntax, semantics, witness patterns, circuit authoring → ADAvault midnight-skill.
- Generative Compact code, contract scaffolding, AI-driven contract authoring → Olanetsoft midnight-mcp.
- Browser-side Lace integration (Mesh.js, dapp connector, web wallet UX) → meshjs Midnight docs.
- Token economics, NIGHT supply, governance design → official Midnight docs at [docs.midnight.network](https://docs.midnight.network/).
- Pricing, market data, bridge UX flows beyond protocol mechanics.
- General Solidity, EVM, hardhat, foundry, Groth16 circuit authoring → use the corresponding language/tool agents.
- Pure performance tuning unrelated to Midnight (Node.js perf, container sizing) → infrastructure agents.

If the user's question isn't in the trigger list and isn't in any decision-tree row, ask one clarifying question. Don't invent a Midnight angle that isn't there.
