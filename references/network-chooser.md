# network-chooser

> When to use this doc: you are picking which Midnight network to target, or your backend is failing to reach RPC / indexer / faucet from a server. Covers preview vs preprod vs local-playground vs mainnet, the cloud-IP RPC block, and the Cloudflare Worker reverse-proxy that fixes it.

## Contents

- 1. Network options
- 2. How to choose
- 3. Cloud-IP RPC block (the 403 problem)
- 4. Faucet workarounds
- 5. Genesis hash verification
- 6. Diagnostic recipes
- See also

## 1. Network options

| Network | Purpose | Indexer | RPC | Faucet | Genesis hash | Status |
|---|---|---|---|---|---|---|
| `preview` | Default for dev / E2E | `https://indexer.preview.midnight.network/api/v3/graphql` | `wss://rpc.preview.midnight.network` | `https://faucet.preview.midnight.network/` | `0x801d3fc306115a3b538ea9498881c176376f8e3213464fe620fc1f359d13b880` | Live; typically reachable from cloud VMs (verify with `scripts/rpc-reachability-probe.mjs`) |
| `preprod` | Staging-equivalent | `https://indexer.preprod.midnight.network/api/v3/graphql` | `wss://rpc.preprod.midnight.network` | `https://faucet.preprod.midnight.network/` | derived per-deploy; verify via indexer | Live; AWS ELB blocks cloud-provider IPs (HTTP 403). See Section 3. |
| `local-playground` | Fast iteration, no faucet | `http://localhost:8088/api/v3/graphql` | `ws://localhost:9944` | n/a (genesis-funded wallet) | local | Best for tight loops. See [forum.midnight.network/t/.../1002](https://forum.midnight.network/t/local-playground-for-midnight-compact-contracts-run-a-full-node-indexer-and-proof-server-via-docker-fund-your-lace-wallet-and-deploy-without-testnets-or-faucets/1002). |
| `mainnet` | Production | post-launch endpoints | post-launch endpoints | n/a | n/a | Live; production only, gate behind audit. |
| `lace-proof-pub.preprod.midnight.network` | (was hosted proof server) | n/a | n/a | n/a | n/a | DECOMMISSIONED. DNS does not resolve. Run a local proof-server in Docker instead. |

## 2. How to choose

Decision tree, in order:

1. Iterating on Compact contract code with no need to share state? Use `local-playground`. It runs a full node + indexer + proof-server in Docker, and the genesis block funds your Lace wallet directly. No faucet, no Turnstile, no ELB block.

2. Running tests from a personal laptop? Use `preview`. Reachable from residential IPs, faucet works, cold sync is ~20 minutes.

3. Running a backend on GCP / AWS / DigitalOcean / any cloud provider, and the corridor partner requires preprod? Use `preprod` via the Cloudflare Worker reverse-proxy described in Section 3. Direct RPC will return HTTP 403.

4. Running a backend on a cloud VM and `preview` is acceptable? Use `preview`. No proxy required.

5. Shipping production? Use `mainnet`, gated behind a security review.

## 3. Cloud-IP RPC block (the 403 problem)

### Symptom

```
GET https://rpc.preprod.midnight.network/
< HTTP/1.1 403 Forbidden
< server: awselb/2.0
< content-length: 118
```

The RPC endpoint returns 403 from every method and path. The body is a static 118-byte error page from AWS Elastic Load Balancer. The indexer at `indexer.preprod.midnight.network` on the same zone is unaffected.

### Root cause

The block is ASN-scoped at the AWS ELB listener. Verified by raw headers (`server: awselb/2.0`); not Cloudflare WAF, not user-agent, not URL path. GCP, AWS, and DigitalOcean egress IPs all hit it. Residential IPs reach the Substrate node and get a 405 (method not allowed) on bare GET.

### Fix: Cloudflare Worker reverse-proxy

The Worker terminates the client connection on Cloudflare's edge (ASN 13335, which is not on the AWS reputation list) and re-originates the request to the upstream Substrate node. It pass-throughs both HTTPS and WSS (preserving SNI), and streams long-lived subscriptions like `author_submitAndWatchExtrinsic`.

The full Worker is shipped in `assets/cloudflare-worker-template/`:

- `wrangler.toml` — Worker config that binds a custom domain. The `custom_domain = true` flag is required so DNS is auto-provisioned on first deploy; plain `[[routes]]` with `zone_name` only would skip DNS creation.
- `src/index.ts` — Worker handler. Strips hop-by-hop headers, pass-throughs HTTP and WebSocket, has a `/__canary` endpoint for upstream health checks.

### Deploy steps

```bash
cd midnight-ops-doctor/assets/cloudflare-worker-template
npm install

# Edit wrangler.toml: replace the route pattern with your custom domain.
# Required: a Cloudflare zone you control + custom_domain = true.
$EDITOR wrangler.toml

npx wrangler login
npx wrangler deploy
```

After deploy, point your backend's `MIDNIGHT_NODE_RPC` env var at `wss://<your-worker-domain>/`. The proxy passes WSS and HTTPS on the same hostname; no separate endpoint for the JSON-RPC fallback.

### Verify

```bash
# 1. Canary: classifies the upstream as healthy, blocked, or unknown.
curl -s https://<your-worker-domain>/__canary | jq .
# Expected: {"status":"healthy","upstreamStatus":405,"server":"...","checkedAt":"..."}

# 2. JSON-RPC round-trip:
curl -s -X POST https://<your-worker-domain> \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}'
# Expected: {"jsonrpc":"2.0","result":{"peers":N,"isSyncing":false,...},"id":1}

# 3. WebSocket round-trip (requires wscat):
wscat -c wss://<your-worker-domain>
> {"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}
< {"jsonrpc":"2.0","result":{...},"id":1}
```

### What the Worker does NOT do

- No auth. Midnight RPC is public.
- No rate limiting. Add via Cloudflare zone rules if abuse appears.
- No indexer proxying. Indexer is not blocked.
- No body logging. Bodies contain signed transaction data.

### Retired workaround

An older SSH reverse-tunnel pattern (writing `127.0.0.1 rpc.preprod.midnight.network` into `/etc/hosts` on the VM and opening `ssh -R 443:rpc.preprod.midnight.network:443 root@<vm>` from a residential machine) is retired. It worked but required a permanently-up SSH session from a residential IP. The Worker replaces it with a passive edge service.

## 4. Faucet workarounds

### Constraint

Both `preview` and `preprod` faucets are web-only and Cloudflare Turnstile-protected. The frontend POSTs to `/api` with a `requestTokens(address, captchaToken)` call. There is no programmatic bypass; the captcha token is one-shot and bound to the browser session.

### When the faucet is fully down

The preprod faucet has had multi-hour outages where `/api/health` and `/api/drips/:id` return `ERR_EMPTY_RESPONSE`. Recovery options, in order of ease:

1. Switch network to `preview`. Most testnet work doesn't require preprod specifically.
2. Switch to `local-playground`. No faucet; genesis funds your wallet.
3. Wallet-to-wallet transfer from a previously-funded address. Requires a NIGHT-funded sender; pattern documented in [forum.midnight.network/t/.../1098](https://forum.midnight.network/t/complete-hello-world-guide-from-setup-to-deployed-contract-with-troubleshooting/1098).

### Per-address rate limit

Each address can be dripped a fixed amount per window. Submitting again returns "Services are currently unavailable" or a generic rate-limit page. Use a fresh address (rotate seed) if you need more, or wait for the window to reset.

## 5. Genesis hash verification

After flipping `MIDNIGHT_NETWORK_ID`, confirm the indexer points where you think it does. Query for the genesis block by hash and check the response echoes the same hash:

```bash
curl -s "$MIDNIGHT_INDEXER_URL" \
  -H 'content-type: application/json' \
  --data '{
    "query": "query { block(offset: { hash: \"0x801d3fc306115a3b538ea9498881c176376f8e3213464fe620fc1f359d13b880\" }) { hash } }"
  }' | jq '.data.block.hash'
# Expected: "0x801d3fc306115a3b538ea9498881c176376f8e3213464fe620fc1f359d13b880" (preview)
```

A `null` response means the indexer is on a different network (or the hash is wrong). The `WalletFacade.init` flow validates the genesis hash against the wallet's expected network on its own, so a mismatch will also surface at adapter init time, but verifying via curl is faster.

## 6. Diagnostic recipes

### "My backend can't reach preprod from a cloud VM"

1. Curl the upstream directly:
   ```bash
   curl -sk -o /dev/null -w "%{http_code}\n" https://rpc.preprod.midnight.network/
   ```
   - `403` → AWS ELB block. Deploy the Worker (Section 3).
   - `405` → reachable; the issue is elsewhere (auth, body size, sync).
   - `000` → DNS or network failure; check egress.

2. If 403, deploy the Cloudflare Worker per Section 3 and repoint `MIDNIGHT_NODE_RPC`.

3. If still failing after Worker deploy, hit the canary:
   ```bash
   curl -s https://<your-worker-domain>/__canary | jq .
   ```
   - `"status":"blocked"` → AWS extended the block to Cloudflare's ASN (signal for tier-2 proxy on Hetzner / Fly.io residential ASN).
   - `"status":"healthy"` → Worker is fine; backend config is wrong. Check `MIDNIGHT_NODE_RPC` is the Worker URL, not the upstream.

### "Faucet returned 200 but my balance shows 0"

Three causes, in order of likelihood:

1. Wrong address sent to the faucet. `wallet.getWalletAddress()` returns the shielded coinPublicKey (32-byte hex), NOT the unshielded bech32m address. Faucet drops only land on the bech32m unshielded address. See `references/three-addresses.md`.

2. Wallet not synced. Balance reads against a partially-synced wallet return 0 even after the drop is finalized. Check sync status via the sidecar: `GET http://127.0.0.1:8090/wallet/diagnostics` (header `x-midnight-sidecar-token: $MIDNIGHT_SIDECAR_TOKEN`).

3. Network mismatch. You sent to the bech32m address derived against a different network ID. `mn_addr_preview1...` and `mn_addr_preprod1...` are non-interchangeable. Verify the faucet UI's network toggle matches your `MIDNIGHT_NETWORK_ID`.

### "I deployed to preview but expected preprod" (or vice versa)

The wallet seed produces different bech32m addresses on each network (network ID is mixed into the bech32m HRP). If you flipped `.env` from `preprod` to `preview` without wiping the wallet DB, the snapshot `networkId` field will mismatch and snapshot validation rejects it at restore time. Recovery: stop container, `docker volume rm <your-project>_midnight-db`, restart.

## See also

- `references/three-addresses.md` — why your faucet drop "disappeared"
- `references/wallet-lifecycle.md` — sync timing, snapshot restore, deploy
- `references/symptom-catalog.md` — `err-elb-403`, `err-decommissioned-rpc`
