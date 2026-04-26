# symptom-catalog

> When to use this doc: you have a specific error string, log line, or observable failure on a Midnight integration and want the fix without reading code. Search by Ctrl-F against the symptom phrase or `err-<id>`.

Each entry: diagnosis, fix, related entries.

## Contents (20 indexed errors)

Wallet & sync
- `err-139` — `Custom error: 139` from node on tx submit
- `err-sync-stuck-50` — wallet sync stuck below 100% for hours
- `err-submitTx-timeout` — `submitTx inner timeout` after 90s
- `err-snapshot-gcs` — snapshot upload fails with `Provided scope(s) are not authorized`

Three-address / funding
- `err-address-wrong` — faucet drop succeeded but balance is 0
- `err-getWalletAddress-wrong` — `wallet.getWalletAddress()` returns wrong format
- `err-dust-zero` — backend has NIGHT but DUST balance is 0
- `err-dust-tab-empty` — Lace Midnight tab shows no DUST after fresh wallet

Deploy & submit
- `err-deploy-hang` — `deployContract()` hangs forever
- `err-waf-8kb` — submitTx HTTP 413 / timeout for tx >8KB
- `err-elb-403` — HTTP 403 from `rpc.preprod.midnight.network` on a cloud VM
- `err-decommissioned-rpc` — `lace-proof-pub.preprod.midnight.network` DNS fails

SDK / Lace / runtime
- `err-cjs-esm` — `ERR_UNSUPPORTED_DIR_IMPORT` from `@midnight-ntwrk/wallet-sdk-facade`
- `err-wallet-stop-vs-close` — `wallet.close is not a function`
- `err-wrong-token-api` — `nativeToken is not a function`
- `err-signRecipe-bug` — `signRecipe()` produces invalid signatures
- `err-lace-clone-intent` — Lace error "Failed to clone intent"

Hashlock / proof / verifier
- `err-persistent-hash-mismatch` — Compact persistentHash differs from Node SHA-256
- `err-proof-server-version` — proof generation fails after SDK upgrade
- `err-vk-mismatch` — `scripts/deploy-verifier.mjs` Check 5 reports vk byte-equality FAIL

---

## err-139: `Custom error: 139` from node on tx submit

**Diagnosis:** Wallet submitted a tx whose UTXO set is stale relative to the current chain tip. The Substrate node rejects it because at least one input refers to an output that has been spent or never existed at the node's view of state. Almost always caused by submitting before the wallet finished syncing.

**Fix:**

```typescript
// Wait for full sync before submitting any tx. Adapter exposes
// readWalletStateOnce() which reports sync progress; gate on the
// strict-complete flag.
const state = await adapter.readWalletStateOnce();
if (!state.isSynced) {
  throw new Error('refusing to submit while wallet is not strictly synced');
}
// Now safe to call createHTLC / withdrawHTLC / refundHTLC.
```

If a snapshot restore left you partially synced, the safest recovery is to wipe and cold-sync:

```bash
sudo docker compose rm -sf backend
sudo docker volume rm <your-project>_midnight-db
sudo docker compose up -d backend
# Cold sync ~20 min on preview, longer on preprod.
```

**Related:** `err-sync-stuck-50`, `err-snapshot-gcs`.

---

## err-cjs-esm: `ERR_UNSUPPORTED_DIR_IMPORT` from `@midnight-ntwrk/wallet-sdk-facade`

**Diagnosis:** All `@midnight-ntwrk/wallet-sdk-*` packages ship as ESM only (`"type": "module"` in package.json, no CJS build). Loading them via `require(...)` or top-level `import` from a CommonJS-compiled backend fails at module resolution.

**Fix:** Use `import type` for compile-time and dynamic `import()` for runtime:

```typescript
// Type-only: erased at compile time, never executed.
import type {
  WalletFacade as SdkWalletFacade,
  FacadeState as SdkFacadeState,
} from '@midnight-ntwrk/wallet-sdk-facade';

async function loadFacade() {
  // Runtime: dynamic import works from CJS into ESM.
  const facadeMod = await import('@midnight-ntwrk/wallet-sdk-facade');
  return facadeMod.WalletFacade;
}
```

**Related:** `err-wallet-stop-vs-close`, `err-wrong-token-api`.

---

## err-waf-8kb: submitTx HTTP 413 / timeout for tx >8KB

**Diagnosis:** AWS WAF on the preprod RPC HTTP gateway drops POST bodies larger than 8 KiB. Signed Midnight transactions with proofs routinely exceed 100 KiB, so any tx submission via the HTTP RPC path silently times out or returns an opaque error.

**Fix:** Submit via the wallet's internal WebSocket relay instead of the HTTP path:

```typescript
async submitTx(tx: any): Promise<string> {
  // wallet.submitTransaction routes via PolkadotNodeClient over WSS,
  // which does not have the 8KiB body limit and waits for Finalized.
  const txId = await Promise.race([
    adapter.wallet.submitTransaction(tx),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('submitTx inner timeout')),
      SUBMIT_TX_INNER_TIMEOUT_MS,
    )),
  ]);
  return txId as string;
}
```

The `MidnightProvider.submitTx` field on your providers bundle should delegate to `wallet.submitTransaction`, NOT to a direct `httpClientNodeRPCProvider.submitTx`.

**Related:** `err-elb-403`, `err-submitTx-timeout`.

---

## err-elb-403: HTTP 403 from `rpc.preprod.midnight.network` on a cloud VM

**Diagnosis:** The upstream is fronted by an AWS Elastic Load Balancer listener rule that ASN-blocks GCP, AWS, DigitalOcean, and similar cloud egress IPs. Identifiable by `server: awselb/2.0` in the response headers.

**Fix:** Deploy the bundled Cloudflare Worker reverse-proxy from `assets/cloudflare-worker-template/`:

```bash
cd midnight-network-dev/assets/cloudflare-worker-template
npm install
$EDITOR wrangler.toml   # set route pattern to your custom domain
npx wrangler login
npx wrangler deploy
```

Then point your backend env at the Worker:

```bash
MIDNIGHT_NODE_RPC=wss://<your-worker-domain>
```

**Related:** `references/network-chooser.md` Section 3, `err-decommissioned-rpc`.

---

## err-deploy-hang: `deployContract()` hangs forever

**Diagnosis:** `@midnight-ntwrk/midnight-js-contracts.deployContract()` internally calls `watchForTxData()` with no timeout. If the indexer is slow or the tx never finalizes, the call never returns. The process appears hung at `Deploying HTLC contract...`.

**Fix:** Use the manual phased flow with timeouts on each phase:

```typescript
// 1. createUnprovenDeployTx (synchronous-ish)
const unprovenTx = await contract.createUnprovenDeployTx(providers, deployArgs);

// 2. proveTx with timeout
const provenTx = await withTimeout(
  providers.proofProvider.proveTx(unprovenTx),
  DEPLOY_PHASE_TIMEOUT_MS,
  'deploy.proveTx',
);

// 3. balanceTx with timeout
const balancedTx = await withTimeout(
  providers.walletProvider.balanceTx(provenTx),
  DEPLOY_PHASE_TIMEOUT_MS,
  'deploy.balanceTx',
);

// 4. submitTx via WebSocket (avoids err-waf-8kb)
const txId = await withTimeout(
  providers.midnightProvider.submitTx(balancedTx),
  SUBMIT_TX_OUTER_TIMEOUT_MS,
  'deploy.submitTx',
);

// 5. watchForTxData with timeout (the ONE place watchForTxData is OK)
const finalized = await withTimeout(
  providers.publicDataProvider.watchForTxData(txId),
  CONFIRM_TIMEOUT_MS,
  'deploy.confirm',
);
```

Reasonable timeout constants: inner submitTx 90s, outer 150s, deploy phase 660s, confirm 120s. See the full six-phase walkthrough in `references/wallet-lifecycle.md`.

**Related:** `err-submitTx-timeout`, `err-waf-8kb`.

---

## err-sync-stuck-50: wallet sync stuck below 100% for hours

**Diagnosis:** Cold sync on preprod takes 30+ minutes after a chain reset, longer on busy days. Cold sync on preview takes ~20 minutes. Anything beyond ~2 hours indicates the wallet DB volume is corrupt or holding stale state from a different network/seed.

**Fix:**

```bash
# Stop the container first so it releases the volume.
sudo docker compose rm -sf backend

# Wipe the LevelDB volume.
sudo docker volume rm <your-project>_midnight-db

# Cold sync from genesis.
sudo docker compose up -d backend
sudo docker compose logs -f --since=1m backend
# Watch for "Wallet sync complete" or sync progress reaching strict-complete.
```

**Related:** `err-139`, `err-snapshot-gcs`.

---

## err-address-wrong: faucet drop succeeded but balance is 0

**Diagnosis:** Almost always: you sent the faucet the shielded coinPublicKey hex (32-byte 0x-prefixed) instead of the unshielded bech32m address (`mn_addr_preview1...` / `mn_addr_preprod1...`). NIGHT only lives on the unshielded address; faucet drops sent to the shielded hex are effectively orphaned.

**Fix:** Get the bech32m address from the sidecar:

```bash
curl -s -H "x-midnight-sidecar-token: $MIDNIGHT_SIDECAR_TOKEN" \
  http://127.0.0.1:8090/wallet/diagnostics \
  | jq -r '.addresses.unshieldedAddress'
# Expected: mn_addr_preview1... (or mn_addr_preprod1...)
```

Then drop NIGHT to that address. `wallet.getWalletAddress()` returns the WRONG address for this purpose. See `err-getWalletAddress-wrong`.

**Related:** `err-getWalletAddress-wrong`, `references/three-addresses.md`.

---

## err-dust-zero: backend has NIGHT but DUST balance is 0

**Diagnosis:** Either (a) `registerNightUtxosForDustGeneration` has not run for this wallet, or (b) it ran less than ~90s ago and the backend state has not refreshed, or (c) <12h since accrual started and the amount is just very small.

**Fix:** Run the Lace bootstrap (verified working on preview):

1. Import the same seed/mnemonic into Lace.
2. Lace → Midnight tab → tNIGHT Designation flow.
3. Wait ~90s.
4. Re-read backend balance.

If headless, call your adapter's equivalent of `designateDust()` directly:

```typescript
// adapter is a fully-initialized wallet adapter
const result = await adapter.designateDust({ utxoSelector: 'all' });
console.log('designation tx:', result.txId);
// Wait ~90s for accrual, then re-read balance.
```

**Related:** `err-dust-tab-empty`, `references/dust-night-registration.md`.

---

## err-persistent-hash-mismatch: Compact persistentHash differs from Node SHA-256

**Diagnosis:** `assertPersistentHashReady()` threw at boot. Either the compact-runtime is not loaded, or an SDK upgrade changed the algorithm underlying `persistentHash<Bytes<32>>`. The adapter refuses to mark itself operational because `computeHashlock` would silently produce unredeemable HTLCs.

**Fix:** First, verify the runtime loaded:

```bash
# Search backend logs for the success line.
sudo docker compose logs backend | grep "persistentHash self-test passed"
# If absent, runtime did not load. Check getRuntimeModules failures upstream.
```

If the runtime loaded but the test still fails, the SDK regressed. Pin to the previous version of `@midnight-ntwrk/compact-runtime` in `package.json`, rebuild, and file an upstream bug. Don't silence the self-test; `computeHashlock` is fail-closed for a reason.

**Related:** `references/cross-family-hashlocks.md`, `references/version-matrix.md`.

---

## err-snapshot-gcs: snapshot upload fails with `Provided scope(s) are not authorized`

**Diagnosis:** A GCP Compute Engine VM's default service account has `devstorage.read_only` in its scope set, not `read_write`. Local snapshot writes still succeed (filesystem only); GCS uploads fail silently as a WARN log line, leaving you with no off-VM snapshot for disaster recovery.

**Fix:** Grant the VM service account read-write on the bucket. Requires ~2 minutes of downtime:

```bash
PROJECT=<your-gcp-project>
ZONE=<your-zone>
VM=<your-instance-name>
SA=<your-service-account-email>
BUCKET=<your-snapshot-bucket>

# Stop the VM (scope changes require power-off).
gcloud compute instances stop $VM --zone=$ZONE --project=$PROJECT

# Re-set scopes to include storage RW alongside the standard set.
gcloud compute instances set-service-account $VM \
  --zone=$ZONE --project=$PROJECT \
  --service-account=$SA \
  --scopes=cloud-platform,devstorage.read_write,logging-write,monitoring-write

# Grant bucket-level IAM.
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$SA \
  --role=roles/storage.objectUser

# Restart.
gcloud compute instances start $VM --zone=$ZONE --project=$PROJECT
```

**Related:** None. This is an ops issue, not a Midnight protocol issue.

---

## err-proof-server-version: proof generation fails after SDK upgrade

**Diagnosis:** The proof-server image version must match the ledger version your contract was compiled against. ledger-v6 needs proof-server 4.0.0; ledger-v7 needs >= 7.x; ledger-v8 needs >= 8.0.0. A version mismatch produces opaque errors like "proof generation failed" with no useful detail.

**Fix:** Pin the proof-server image in `docker-compose.yml`:

```yaml
proof-server:
  image: midnightntwrk/proof-server:8.0.3   # match ledger-v8
  command: ["midnight-proof-server", "-v"]
  ports:
    - "6300:6300"
  restart: unless-stopped
```

For deploy scripts that target the older v7 matrix, 7.0.2 is the known-good pin.

**Related:** `references/version-matrix.md`.

---

## err-lace-clone-intent: Lace error "Failed to clone intent"

**Diagnosis:** Lace wallet state race. Triggered when the Lace runtime is mid-operation on an intent and a second action arrives before the first settles. Not a protocol mismatch.

**Fix:** Operationally:

1. Close all but one Lace tab.
2. Wait for any spinner / pending tx indicator to clear.
3. Retry the action.

If it keeps reproducing, restart the Lace extension entirely (disable + re-enable in the browser's extension manager).

**Related:** `err-dust-tab-empty`.

---

## err-dust-tab-empty: Lace Midnight tab shows no DUST after fresh wallet

**Diagnosis:** ~12-hour accrual period after `registerNightUtxosForDustGeneration` runs for the first time on a fresh wallet. Visible balance starts at ~0 and rises linearly. Below ~10 minutes this is normal; above ~30 minutes with a synced wallet, designation likely never ran.

**Fix:** Wait ~10 minutes. If still zero, verify designation actually ran by checking the on-chain registration tx receipt. If no receipt, re-run the Lace tNIGHT Designation flow.

**Related:** `err-dust-zero`, `references/dust-night-registration.md`.

---

## err-decommissioned-rpc: `lace-proof-pub.preprod.midnight.network` DNS fails

**Diagnosis:** The hosted public proof-server endpoint was decommissioned. DNS no longer resolves. Anything pointing at it as a `MIDNIGHT_PROOF_SERVER` URL will fail.

**Fix:** Run a local proof-server in Docker:

```bash
# For the v8 ledger / latest backend:
docker run -d --name midnight-proof -p 6300:6300 midnightntwrk/proof-server:8.0.3

# For the v7 deploy-script matrix:
docker run -d --name midnight-proof -p 6300:6300 midnightntwrk/proof-server:7.0.2
```

Then in `.env`:

```bash
MIDNIGHT_PROOF_SERVER=http://127.0.0.1:6300
```

**Related:** `err-proof-server-version`, `references/version-matrix.md`.

---

## err-submitTx-timeout: `submitTx inner timeout` after 90s

**Diagnosis:** `wallet.submitTransaction(tx)` did not resolve within `SUBMIT_TX_INNER_TIMEOUT_MS` (90s). The WebSocket relay either died mid-flight or upstream is non-responsive. The adapter should tear down the wallet and flag it for rebuild on the next call.

**Fix:** Mostly handled automatically. `walletNeedsRebuild` is set to true and the next `withdrawHTLC` / `createHTLC` call triggers `recoverWallet()`. Manual recovery:

```typescript
if (adapter.walletNeedsRebuild) {
  await adapter.recoverWallet();
}
```

If timeouts repeat, the upstream RPC is unhealthy. Check the `__canary` endpoint on your reverse-proxy (Section `err-elb-403`) and the upstream's `system_health` JSON-RPC call.

**Related:** `err-elb-403`, `err-waf-8kb`.

---

## err-wallet-stop-vs-close: `wallet.close is not a function`

**Diagnosis:** Old `@midnight-ntwrk/wallet` API used `close()`. The current `@midnight-ntwrk/wallet-sdk-facade` uses `stop()`.

**Fix:**

```typescript
// WRONG — TypeError on the current SDK.
await wallet.close();

// CORRECT — current SDK.
await wallet.stop();
```

**Related:** `err-cjs-esm`, `references/version-matrix.md`.

---

## err-wrong-token-api: `nativeToken is not a function`

**Diagnosis:** `nativeToken()` was a top-level export on the old `@midnight-ntwrk/ledger` (v6 era). On `ledger-v7` and later the API moved: `unshieldedToken().raw` is the canonical 32-byte token domain separator for NIGHT.

**Fix:**

```typescript
// WRONG — undefined on ledger-v7+.
const nightTokenId = nativeToken();

// CORRECT — works on ledger-v7 and ledger-v8.
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
const nightTokenId = unshieldedToken().raw; // 32-byte hex domain separator
```

**Related:** `references/version-matrix.md` ledger row.

---

## err-signRecipe-bug: `signRecipe()` produces invalid signatures

**Diagnosis:** The `signRecipe()` helper in current wallet-sdk-facade versions produces signatures that the ledger rejects. Bypass it by signing the registration payload directly with the unshielded keystore.

**Fix:**

```typescript
// WRONG — signRecipe has the bug.
const recipe = await wallet.registerNightUtxosForDustGeneration(
  utxos, nightVerifyingKey, wallet.signRecipe, dustReceiverAddress,
);

// CORRECT — sign with the keystore directly.
const keystore = unshieldedKeystore;
const nightVerifyingKey = keystore.getPublicKey();
const signDustRegistration = (payload: Uint8Array) => keystore.signData(payload);

const recipe = await wallet.registerNightUtxosForDustGeneration(
  utxos, nightVerifyingKey, signDustRegistration, dustReceiverAddress,
);
```

**Related:** `references/dust-night-registration.md` Section 2.

---

## err-getWalletAddress-wrong: `wallet.getWalletAddress()` returns wrong format

**Diagnosis:** `getWalletAddress()` on the WalletFacade returns ONLY the shielded coinPublicKey (32-byte hex, padded to 0x + 64 chars). It does not return the unshielded bech32m address that NIGHT lives on, nor the DUST address. Code that treats `getWalletAddress()` as "the wallet address" produces the three-address bug.

**Fix:** Use the sidecar `/wallet/diagnostics` endpoint to read all three:

```bash
curl -s -H "x-midnight-sidecar-token: $MIDNIGHT_SIDECAR_TOKEN" \
  http://127.0.0.1:8090/wallet/diagnostics | jq .addresses
# {
#   "shieldedCoinPublicKey": "0x...64hex",
#   "unshieldedAddress": "mn_addr_preview1...",
#   "dustAddress": "mn_dust_preview1..."
# }
```

In code, hold an address bundle and pick the right field per use case:

- Faucet / NIGHT balance / unshielded UTXO ops → `unshieldedAddress`
- DUST receiver / DUST balance → `dustAddress`
- Shielded zswap operations → `shieldedCoinPublicKey`

**Related:** `err-address-wrong`, `references/three-addresses.md`.

---

## err-vk-mismatch: `scripts/deploy-verifier.mjs` Check 5 reports vk byte-equality FAIL

**Diagnosis:** The on-chain Groth16 verifier's verification key (baked into bytecode as immutable scalars) does not match the verification key derived from your local `.zkey`. The verifier will return `false` for every proof, even valid ones. Funds in any HTLC, escrow, or vault gated on this verifier are stuck until timelock refunds fire. Same bug class that lost funds at FOOM Club and Veil Protocol; caught pre-funds-loss in a real production deployment (full incident playbook in `references/groth16-vk-mismatch.md`).

**Fix:** Treat as a P0 incident. Two remediation paths:

```bash
# A) Redeploy the verifier from your local zkey (most common path)
snarkjs zkey export solidityverifier ./build/settlement_proof_final.zkey \
  ./contracts/SettlementVerifier.sol
# Deploy SettlementVerifier.sol via your tool of choice; update any
# contract that references the verifier to point at the new address.

# B) Restore canonical zkey from ceremony output (when the deployed
# verifier is canonical and cannot be redeployed, e.g. mainnet)
cp <canonical-zkey-from-ceremony> ./build/settlement_proof_final.zkey

# Re-run Check 5 to confirm resolution
node scripts/deploy-verifier.mjs deploy-manifest.json
```

Never run `snarkjs zkey contribute` to "fix" a divergent zkey. Every contribution randomizes the delta point, making the mismatch worse.

**Related:** `references/groth16-vk-mismatch.md` (full incident playbook with detection, response, and prevention controls).

---

## See also

- `references/three-addresses.md` — three-address mental model
- `references/wallet-lifecycle.md` — sync, deploy phases, snapshots
- `references/network-chooser.md` — RPC reachability and faucet recipes
- `references/dust-night-registration.md` — DUST bootstrap
- `references/cross-family-hashlocks.md` — SHA-256 parity
- `references/version-matrix.md` — proof-server / ledger / SDK pinning
- `references/groth16-vk-mismatch.md` — Groth16 vk-mismatch incident playbook
