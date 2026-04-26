# version-matrix

> When to use this doc: you are pinning Midnight component versions, debugging a "works in dev / fails in CI" version drift, or planning an SDK upgrade and need to know which other components must move with it.

## Contents

- 1. Compatibility matrix (proof-server, ledger, wallet-sdk, contracts, Compact)
- 2. Decommissioned endpoints
- 3. Pinning recommendations
- 4. CJS / ESM constraint
- 5. Diagnostic recipes
- See also

## 1. Compatibility matrix

| Component | Versions seen | Notes |
|---|---|---|
| `midnightntwrk/proof-server` (Docker) | `4.0.0`, `6.x`, `7.0.2`, `8.0.3` | Must match the ledger version your contract uses. v8 ledger needs proof-server >= 8.0.0; v7 ledger needs 7.x; legacy v6 ledger uses 4.0.0 per [forum.midnight.network/t/.../727](https://forum.midnight.network/t/please-use-proof-server-version-4-0-0/727). |
| `@midnight-ntwrk/ledger-vN` | v6, v7, v8 | v6 → v7 broke the token API: `nativeToken()` removed, replaced by `unshieldedToken().raw`. Token IDs are 32-byte raw hex. |
| `@midnight-ntwrk/wallet` | DEPRECATED | Old facade, replaced by `wallet-sdk-facade`. Do not use. |
| `@midnight-ntwrk/wallet-sdk-facade` | 2.x (legacy), 3.0.0 (current) | Constructor changed from `new WalletFacade(...)` to `WalletFacade.init({ configuration, shielded, unshielded, dust })`. Use `wallet.stop()`, not `wallet.close()`. `signRecipe()` has a bug; bypass with manual keystore signing per `err-signRecipe-bug`. |
| `@midnight-ntwrk/midnight-js-contracts` | 4.0.4 | Avoid `deployContract()`. It calls unbounded `watchForTxData`. Use the manual phased flow per `err-deploy-hang`. |
| `@midnight-ntwrk/midnight-js-network-id` | current | Provides `setNetworkId` / `getNetworkId`. Has a CJS build, runtime-imported directly. |
| `@midnight-ntwrk/compact-runtime` | 0.14.0 (v7 era), 0.15.0 (current) | Runtime semantics for `persistentHash<Bytes<32>>` must equal Node SHA-256. The boot self-test enforces this; an SDK upgrade that breaks parity is fail-closed. |
| `@midnight-ntwrk/compact-js` | current | ESM-only, load via dynamic `import()` from CJS code. |
| Compact compiler (CLI) | 0.20.x, 0.29.x, 0.30.x | Major-version bumps can break contract source compatibility. Cross-check with [docs.midnight.network](https://docs.midnight.network/) before upgrading. |
| `onchain-runtime-vN` (WASM) | v2 (legacy), v3 (current) | Mixing v2 + v3 in the same process produces `ContractMaintenanceAuthority` `_assertClass` errors at deploy time. Dedupe runtime modules onto a single backend copy to prevent it. |
| Indexer GraphQL | v1, v3, v4 | v1 endpoints are decommissioned. v3 is in wide use today. v4 is the current upstream-recommended version per [docs.midnight.network](https://docs.midnight.network/); upgrading requires reviewing query schemas. |

## 2. Decommissioned endpoints

| Endpoint | Replacement |
|---|---|
| `lace-proof-pub.preprod.midnight.network` (DNS no longer resolves) | Run `midnightntwrk/proof-server:8.0.3` (or `:7.0.2` for v7 deploy scripts) locally in Docker on port 6300. See `err-decommissioned-rpc`. |
| Indexer v1 GraphQL endpoints | Use v3 endpoints (`/api/v3/graphql`). v4 is on the roadmap. |

## 3. Pinning recommendations

For the runtime backend on a v8 matrix:

```yaml
# docker-compose.yml — proof-server pin matches ledger-v8.
proof-server:
  image: midnightntwrk/proof-server:8.0.3
```

```jsonc
// backend/package.json — pin to known-good versions.
{
  "dependencies": {
    "@midnight-ntwrk/ledger-v8": "8.0.3",
    "@midnight-ntwrk/compact-runtime": "0.15.0",
    "@midnight-ntwrk/midnight-js-contracts": "4.0.4",
    "@midnight-ntwrk/wallet-sdk-facade": "3.0.0"
  }
}
```

For an older v7-matrix deploy script:

```bash
docker run -d -p 6300:6300 midnightntwrk/proof-server:7.0.2
```

Don't mix the two matrices in one process. Each tool (deploy script, runtime backend) should load its own `node_modules` and dedupe runtime modules so they don't collide.

## 4. CJS / ESM constraint

Every `@midnight-ntwrk/wallet-sdk-*` and `@midnight-ntwrk/compact-js` package is ESM-only. From a CommonJS-compiled backend:

- `import type { ... } from '@midnight-ntwrk/...'` for compile-time only.
- `await import('@midnight-ntwrk/...')` for runtime loading.

This pattern is enforced by the test for `err-cjs-esm`.

## 5. Diagnostic recipes

### "Proof generation fails after SDK upgrade"

1. Check whether the proof-server image version still matches the new ledger version. Update your docker-compose if not.
2. Re-run the boot self-test:
   ```bash
   sudo docker compose logs backend | grep "persistentHash self-test"
   ```
   If absent or failing, the runtime regressed. Pin `@midnight-ntwrk/compact-runtime` back to `0.15.0`.
3. Confirm the contract was compiled against the same ledger version as the runtime expects. Recompile the Compact contract if needed:
   ```bash
   compact compile src/htlc.compact build
   ```

### "Indexer GraphQL returns null for a known query"

1. Verify the endpoint version matches what your client expects:
   ```bash
   echo "$MIDNIGHT_INDEXER_URL"
   # Expected: ...indexer.<network>.midnight.network/api/v3/graphql
   ```
2. If you're hitting v1 endpoints anywhere, migrate to v3. v1 is gone.
3. If on v3 and the schema query fails, the indexer may have dropped support for that query in a recent version. Cross-check via the indexer's `/api/v3/graphql/schema` introspection.

### "Ledger types don't compile after upgrade"

1. Ledger imports are versioned (`@midnight-ntwrk/ledger-v8` etc.). Update both the import and the `package.json` dependency to the new ledger version.
2. Compile errors on `Signature` / `UnprovenTransaction` / `ZswapSecretKeys` shape changes are likely. Expect to update structural types in any wallet-runtime view.
3. Cross-reference the upstream changelog before merging an upgrade.

## See also

- `references/symptom-catalog.md` — `err-proof-server-version`, `err-decommissioned-rpc`, `err-cjs-esm`, `err-persistent-hash-mismatch`
- `references/cross-family-hashlocks.md` — why persistentHash semantics must not regress
- `references/wallet-lifecycle.md` — `initialize()` ordering depends on the matrix above
