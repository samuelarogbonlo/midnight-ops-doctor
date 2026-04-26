# Wallet lifecycle

When to use this doc: a Midnight backend is stuck in init, sync stalls before submitting transactions, `deployContract()` hangs, `submitTx` times out at ~25-30s on a deploy tx, or warm-restart from snapshot fails.

## Contents

- 1. Lifecycle overview
- 2. The sync-completion check
- 3. Cold-sync expectations
- 4. The sidecar `/wallet/diagnostics` endpoint
- 5. The 6-phase manual deploy
- 6. AWS WAF 8KB workaround
- 7. Snapshot save/restore
- 8. Diagnostic recipes
- See also

## 1. Lifecycle overview

State diagram for a backend Midnight wallet adapter from cold start to ready-for-submit.

```
+--------------+       +-------------------+       +------------------+
| not-started  | --->  | building wallet   | --->  | facade.start()   |
+--------------+       | (seed -> 3 keys)  |       | (subscribes WS)  |
                       +-------------------+       +------------------+
                                                            |
                                                            v
                                                   +------------------+
                                                   | syncing          |
                                                   | (sync progress)  |
                                                   +------------------+
                                                            |
                                                  appliedId >= highest
                                                  AND isStrictlyComplete
                                                            |
                                                            v
                                                   +------------------+
                                                   | synced           |
                                                   +------------------+
                                                            |
                                              dust.calculateFee([])
                                              probe succeeds
                                                            |
                                                            v
                                                   +------------------+
                                                   | ready            |
                                                   | (accept submits) |
                                                   +------------------+
```

The four `walletSyncStatus` values: `'not-started' | 'syncing' | 'synced' | 'ready' | 'failed'`. `synced` and `ready` are distinct: `synced` means chain caught up, `ready` means the indexer probe also passed.

Initialization sequence:

1. Load Compact runtime via shared ESM loader (`loadCompactRuntime()`).
2. Run `assertPersistentHashReady()`. Compact `persistentHash` self-test against Node SHA-256 with `0x00...00` and `0xff...ff` golden vectors. Fail-closed on mismatch.
3. Resolve seed, derive 3 keys, build sub-wallets, call `WalletFacade.init({ shielded, unshielded, dust })`.
4. Call `wallet.start(shieldedSecretKeys, dustSecretKey)`. Explicit step in SDK 3.x.
5. Resolve the address bundle (all three addresses).
6. Call `waitForWalletReady()` to gate readiness on full sync + dust check + indexer probe.

## 2. The sync-completion check

A Midnight wallet is "synced" only when every sub-wallet (shielded, unshielded, dust) reports both:

- `appliedId >= highestTransactionId` (everything observed has been applied to local state), AND
- `isStrictlyComplete()` returns `true` (no gaps in the applied range).

If you submit a transaction before this is true, the node rejects with `Custom error: 139` because the wallet's UTXO inputs reference stale or unobserved chain state.

A snapshot helper extracts both checks from a sub-wallet state object:

```typescript
function snapshotWalletProgress(raw: unknown): WalletProgressSnapshot {
  const progress = raw as {
    appliedId?: bigint;
    highestTransactionId?: bigint;
    appliedIndex?: bigint;
    highestIndex?: bigint;
    isConnected?: boolean;
    isStrictlyComplete?: () => boolean;
    isCompleteWithin?: (maxGap?: bigint) => boolean;
  } | undefined;

  return {
    appliedId: progress?.appliedId?.toString()
      ?? progress?.appliedIndex?.toString() ?? 'n/a',
    highestTransactionId: progress?.highestTransactionId?.toString()
      ?? progress?.highestIndex?.toString() ?? 'n/a',
    isConnected: progress?.isConnected ?? null,
    isStrictlyComplete: typeof progress?.isStrictlyComplete === 'function'
      ? progress.isStrictlyComplete() : null,
    isCompleteWithin50: typeof progress?.isCompleteWithin === 'function'
      ? progress.isCompleteWithin(50n) : null,
  };
}
```

Note the field-name dichotomy. SDK 3.x exposes `appliedId` / `highestTransactionId`; older versions used `appliedIndex` / `highestIndex`. The snapshot reads both for compat.

Polling-loop pattern for "wait until ready":

```typescript
async function waitForWalletReady(
  wallet: WalletFacade,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await wallet.state();
    const dustOk = state.dust.progress?.isStrictlyComplete?.() === true;
    const shieldedOk = state.shielded.progress?.isStrictlyComplete?.() === true;
    const unshieldedOk = state.unshielded.progress?.isStrictlyComplete?.() === true;
    if (dustOk && shieldedOk && unshieldedOk) {
      // Probe indexer reachability before declaring ready.
      await wallet.dust.calculateFee([]);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`waitForWalletReady: timeout after ${timeoutMs}ms`);
}
```

A production version should also gate on `dustBalance > 0n` so a wallet with no DUST is rejected at the readiness check.

## 3. Cold-sync expectations

Cold-sync timing depends on chain depth and network. Empirical numbers:

| Network | Cold sync | Warm restart from snapshot |
|---|---|---|
| preview | ~20 min | <60s |
| preprod | >30 min, often hours after a chain reset | <60s |
| local-playground | <60s | <60s |

The Midnight SDK has no birthday or fast-sync primitive. Sync is linear in the number of blocks the node has produced since genesis.

When to wait vs. investigate:

- Wait if `appliedId` is monotonically increasing on the 10s log lines.
- Investigate if `appliedId` is flat for >120s. Check indexer reachability (Section 4) first.
- Investigate if `isConnected: false` on any sub-wallet. The WebSocket relay is dead; restart the container.

Background-sync mode for dev: set `MIDNIGHT_DEFER_WALLET_SYNC=true` to make `waitForWalletReady` mark the adapter ready immediately and run sync in the background. Per-transaction sync gating is still enforced inside each operation. Use this only for dev. Production should fail-fast on sync timeout.

## 4. The sidecar `/wallet/diagnostics` endpoint

A diagnostics sidecar runs on `127.0.0.1:8090` (or `MIDNIGHT_SIDECAR_URL`) and exposes `/wallet/diagnostics` as the canonical health/state inspector. It returns all three addresses, sync progress per sub-wallet, balances, and snapshot-restore state.

Auth: requires the `x-midnight-sidecar-token` header. The token is `MIDNIGHT_SIDECAR_TOKEN` env var, or `midnight-sidecar-dev-token` if `APP_PROFILE=demo`. Outside demo, missing token throws at boot.

Production response shape:

```json
{
  "restoredFromSnapshot": false,
  "walletSyncStatus": "ready",
  "operational": true,
  "isSynced": true,
  "addresses": {
    "shieldedCoinPublicKey": "0x4f1c...3a9b",
    "unshieldedAddress": "mn_addr_preview1...",
    "dustAddress": "mn_dust_preview1..."
  },
  "balances": {
    "tDUST": "37000000",
    "NIGHT": "1000000000000",
    "shielded": {},
    "unshielded": { "<token-id>": "1000000000000" }
  },
  "progress": {
    "shielded": { "appliedId": "...", "highestTransactionId": "...", "isStrictlyComplete": true },
    "unshielded": { "appliedId": "...", "highestTransactionId": "...", "isStrictlyComplete": true },
    "dust": { "appliedId": "...", "highestTransactionId": "...", "isStrictlyComplete": true }
  }
}
```

Curl invocation:

```bash
curl -s -H "x-midnight-sidecar-token: $MIDNIGHT_SIDECAR_TOKEN" \
  http://127.0.0.1:8090/wallet/diagnostics | jq
```

Inside the backend container:

```bash
sudo docker exec <your-backend-container> \
  node -e 'const t=process.env.MIDNIGHT_SIDECAR_TOKEN;
    fetch("http://127.0.0.1:8090/wallet/diagnostics",{headers:{"x-midnight-sidecar-token":t}})
      .then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))'
```

## 5. The 6-phase manual deploy

The SDK's `deployContract()` calls `watchForTxData()` internally with no timeout. If the tx is rejected, propagated late, or never indexed, `deployContract()` hangs forever. No log line, no error. Production-grade code MUST decompose deploy into explicit phases.

```typescript
import {
  createUnprovenDeployTx,
  createCircuitCallTxInterface,
  SucceedEntirely,
} from '@midnight-ntwrk/midnight-js-contracts';

async function deployHTLC(
  providers: SdkMidnightProviders,
  compiledContract: CompiledContract<HTLCContract, any>,
  wallet: WalletFacade,
  privateStateId = 'htlcPrivateState',
): Promise<{ contractAddress: string; txId: string }> {
  // PHASE 1: Build unproven deploy tx (local, fast, <500ms).
  // Throws "Invalid CompactContext" if compact-runtime was loaded twice;
  // clear caches and retry.
  const unproven = await withTimeout(
    createUnprovenDeployTx(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: { preimage: null },
    }),
    10_000, 'phase1: createUnprovenDeployTx',
  );
  const contractAddress = unproven.public.contractAddress;

  // PHASE 2: ZK prove via proof server. Slow: 5-25s depending on circuit + server.
  const proven = await withTimeout(
    providers.proofProvider.proveTx(unproven.private.unprovenTx),
    60_000, 'phase2: proveTx',
  );

  // PHASE 3: Balance + finalize. Selects UTXO inputs, computes fees, finalizes.
  // Throws InsufficientFundsError { tokenType } if no matching UTXO.
  const balanced = await withTimeout(
    providers.walletProvider.balanceTx(proven),
    60_000, 'phase3: balanceTx',
  );

  // PHASE 4: Submit via WebSocket relay (NOT HTTP, see Section 6).
  // Returns the txId once the node accepts the tx. Does NOT wait for finalization.
  const txId = await withTimeout(
    providers.midnightProvider.submitTx(balanced),
    60_000, 'phase4: submitTx',
  );
  if (!txId) throw new Error('phase4: empty txId from submitTx');

  // PHASE 5: Wait for on-chain finalization with explicit timeout.
  // This is the step that hangs forever in deployContract().
  const finalized = await withTimeout(
    providers.publicDataProvider.watchForTxData(txId),
    90_000, 'phase5: watchForTxData',
  );
  if (finalized.status !== SucceedEntirely) {
    throw new Error(
      `Deploy tx confirmed but failed: status=${String(finalized.status)} ` +
      `txId=${txId} address=${contractAddress}`,
    );
  }

  // PHASE 6: Persist private state + signing key (replicates what
  // deployContract did internally).
  providers.privateStateProvider.setContractAddress(contractAddress);
  await providers.privateStateProvider.set(privateStateId, unproven.private.initialPrivateState);
  if (unproven.private.signingKey) {
    await providers.privateStateProvider.setSigningKey(contractAddress, unproven.private.signingKey);
  }

  return { contractAddress, txId };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

Phase budget on a healthy preview/preprod backend:

| Phase | Typical | Pathological |
|---|---|---|
| 1 createUnprovenDeployTx | <500ms | "Invalid CompactContext" → cache clear retry |
| 2 proveTx | 5-25s | proof server overloaded; check `provingServerUrl` |
| 3 balanceTx | 1-5s | `InsufficientFundsError` → wrong token id or no UTXO |
| 4 submitTx | 1-30s | >25s = WAF 8KB body block (Section 6) |
| 5 watchForTxData | 5-60s | hangs forever in `deployContract()`; need explicit timeout |
| 6 store state | <100ms | LevelDB lock → another wallet using same DB path |

## 6. AWS WAF 8KB workaround

Midnight's preprod/preview RPC sits behind AWS WAF. WAF rejects HTTP POST bodies above 8 KB with a generic 5xx and no useful error. A proven Compact deploy tx is typically 50-100 KB. So HTTP `submitTx` always fails for deploys, regardless of network health.

The fix: route submission through the wallet's internal WebSocket relay (PolkadotNodeClient). The wallet exposes `submitTransaction(tx)` which uses WSS, bypassing the HTTP body limit.

Production wrapper:

```typescript
private createMidnightProvider(): SdkMidnightProvider {
  const adapter = this;
  return {
    async submitTx(tx: any): Promise<string> {
      if (!adapter.wallet) throw new Error('submitTx: wallet not initialized');
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const txId = await Promise.race([
          adapter.wallet.submitTransaction(tx),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              adapter.walletNeedsRebuild = true;
              adapter.teardownWalletAfterTimeout();
              reject(new Error('submitTx inner timeout — WS likely dead'));
            }, SUBMIT_TX_INNER_TIMEOUT_MS);
          }),
        ]);
        if (!txId) throw new Error('submitTx returned empty txId');
        return txId as string;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },
  } as unknown as SdkMidnightProvider;
}
```

Key points:

- Capture `this` (the adapter) at provider-creation time, NOT `this.wallet`. The wallet may not be ready when the provider is created; read `this.wallet` at call time.
- On timeout, mark `walletNeedsRebuild = true` so the next op rebuilds the wallet from seed. The WS subscription is dead and won't recover on its own.
- `wallet.submitTransaction()` waits for the node's `Finalized` status before resolving, not just `Broadcast`. Treat its return value as confirmation that the tx is in the mempool, not that it's mined.

## 7. Snapshot save/restore

Warm restart short-circuits cold sync by restoring serialized sub-wallet state from a snapshot file. Restore identity is keyed on `(networkId, seedFingerprint, genesisHash)`. A snapshot from a different network or seed is rejected.

When warm-restart works:

- Same seed, same network, same chain (no genesis reset since the snapshot was saved).
- Local snapshot file exists at `MIDNIGHT_WALLET_SNAPSHOT_FILE` (default: `<MIDNIGHT_PRIVATE_STATE_DB_PATH>/.midnight-wallet-snapshot.json`).
- `MIDNIGHT_WALLET_DISABLE_SNAPSHOT_RESTORE` is not set.

When it doesn't:

- Genesis hash mismatch (chain reset). Snapshot rejected at load, falls back to cold sync.
- Schema version mismatch (`SNAPSHOT_SCHEMA_VERSION` bump). Rejected.
- Seed fingerprint mismatch. Rejected.
- File ownership wrong (root-owned but backend runs as non-root). Load fails silently, cold sync takes over.

### GCS upload failure

If `MIDNIGHT_WALLET_SNAPSHOT_GCS_BUCKET` is set, the backend tries to upload snapshots to GCS in parallel with the local write. On GCE VMs with the default service-account scope set, GCS writes fail with `"Provided scope(s) are not authorized"`. The local write still succeeds, so warm restart on the SAME VM works. But if the VM is replaced, snapshot recovery is impossible.

Fix:

```bash
gcloud compute instances stop <your-instance> --zone=<zone>
gcloud compute instances set-service-account <your-instance> \
  --zone=<zone> \
  --scopes=devstorage.read_write,logging-write,monitoring-write,service-control,service-management
gcloud compute instances start <your-instance> --zone=<zone>
```

Also grant `roles/storage.objectUser` on the bucket to the VM's service account. Total downtime ~2 min.

## 8. Diagnostic recipes

### "Wallet stuck at 50% for hours"

1. Check the per-sub-wallet progress lines. The 10s logger emits `appliedId` + `highestTransactionId` + `isStrictlyComplete` per sub-wallet. Identify which sub-wallet is the bottleneck.
2. If `appliedId` is monotonically increasing: just slow, wait it out.
3. If `appliedId` is flat AND `isConnected: false`: the indexer WebSocket is disconnected. `docker compose restart backend`.
4. If `appliedId` is flat AND `isConnected: true`: the indexer is up but no new events are arriving. Probe the indexer directly:
   ```bash
   curl -X POST $MIDNIGHT_INDEXER_URL \
     -H 'Content-Type: application/json' \
     -d '{"query":"query { block { height } }"}'
   ```
   If the height is also flat, it's a network-level issue, not yours.

### "submitTx silently rejected"

1. Inspect the txId returned by `submitTx`. If empty → WS handshake failed; `walletNeedsRebuild` flag is now set; next op will rebuild.
2. If txId is non-empty but `watchForTxData` times out → the node accepted the tx but it never confirmed. Query the indexer:
   ```bash
   curl -X POST $MIDNIGHT_INDEXER_URL -H 'Content-Type: application/json' \
     -d "{\"query\":\"query { transactions(offset: { identifier: \\\"$TXID\\\" }) { id hash block { height } } }\"}"
   ```
   Empty result after 60s → the tx was rejected during validation. Common causes: stale UTXO inputs (need full sync), insufficient fee, contract address collision.

### "Deploy never returns"

If you used the SDK's `deployContract()`: the hang is at `watchForTxData`. Switch to the 6-phase manual flow (Section 5). There is no fix while still using `deployContract()`.

If you used the 6-phase flow and `submitTx` itself hangs at ~25s, you almost certainly skipped the WebSocket relay (Section 6) and are POSTing >8KB through HTTP. Wire `wallet.submitTransaction(tx)` into your `midnightProvider.submitTx`.

### "Warm-restart loses state"

1. Verify the snapshot file exists: `ls -lh "$MIDNIGHT_PRIVATE_STATE_DB_PATH/.midnight-wallet-snapshot.json"`.
2. Look for `Ignoring stale Midnight wallet snapshot after chain reset` in logs. Means the network's genesis changed. Cold sync is the only path forward.
3. Look for `Failed to restore Midnight wallet snapshot` warning. The restored snapshot was structurally valid but `WalletFacade.init` rejected the deserialized state. The stale snapshot has been deleted; subsequent boot will cold-sync.
4. If the snapshot was loaded from GCS but local restore previously failed: check GCS scopes (Section 7).

## See also

- `three-addresses.md` — derivation, address shapes, faucet routing.
- `network-chooser.md` — picking a network and dealing with cloud-IP RPC blocks.
- `dust-night-registration.md` — required for `dustBalance > 0n` readiness gate.
