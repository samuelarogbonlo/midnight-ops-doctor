# Three addresses

When to use this doc: a user is confused about which Midnight address goes where, has a faucet drop that didn't show up, sees zero balance after sync, or is debugging a derivation mismatch against Lace.

## Contents

- 1. Mental model
- 2. Derivation in code
- 3. Operation-to-address routing
- 4. Address normalization recipes
- 5. Seed derivation gotcha
- 6. Diagnostic recipes
- 7. Use the bundled script
- See also

## 1. Mental model

A single Midnight `MIDNIGHT_SEED` is an HD wallet root. From it you derive three independent keypairs by selecting three roles. Each keypair represents a different ledger surface, and each address format is different.

```
MIDNIGHT_SEED  (32 or 64 bytes)
       |
       v
HDWallet.fromSeed(seed)
       |
       v
.selectAccount(0)
       |
       v
.selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
       |
       v
.deriveKeysAt(0)
       |
       +----> Roles.Zswap         -> ZswapSecretKeys.fromSeed(...)
       |                            .coinPublicKey  (32-byte hex)
       |                            shielded ledger
       |
       +----> Roles.NightExternal -> createKeystore(seed, networkId)
       |                            .getBech32Address()
       |                            mn_addr_<net>1...  (bech32m)
       |                            unshielded NIGHT + UTXOs
       |
       +----> Roles.Dust          -> DustSecretKey.fromSeed(...)
                                    .publicKey -> DustAddress
                                    mn_dust_<net>1...  (bech32m)
                                    dust generation receiver
```

All three are derived from the same seed. There's no "secondary seed" for dust or shielded. Just a role switch in the HD path.

## 2. Derivation in code

```typescript
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import {
  ZswapSecretKeys,
  DustSecretKey,
} from '@midnight-ntwrk/ledger-v8';
import {
  createKeystore,
  MidnightBech32m,
  DustAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

type NetworkId = 'preview' | 'preprod' | 'mainnet';

export interface MidnightAddressBundle {
  shieldedCoinPublicKey: string; // 0x + 64 hex
  unshieldedAddress: string;     // mn_addr_<net>1...
  dustAddress: string;           // mn_dust_<net>1...
}

export function deriveMidnightAddresses(
  seedBytes: Uint8Array,
  networkId: NetworkId,
  account = 0,
  index = 0,
): MidnightAddressBundle {
  const hd = HDWallet.fromSeed(seedBytes);
  if (hd.type !== 'seedOk') {
    throw new Error(`HD seed error: ${hd.type}`);
  }

  const derived = hd.hdWallet
    .selectAccount(account)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(index);
  if (derived.type !== 'keysDerived') {
    throw new Error(`Key derivation failed: ${derived.type}`);
  }

  const zswapKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecret = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKs = createKeystore(derived.keys[Roles.NightExternal], networkId);

  const shieldedHex = String(zswapKeys.coinPublicKey).replace(/^0x/i, '').toLowerCase();
  const padded = shieldedHex.padStart(64, '0');

  const bundle: MidnightAddressBundle = {
    shieldedCoinPublicKey: '0x' + padded,
    unshieldedAddress: unshieldedKs.getBech32Address().toString(),
    dustAddress: MidnightBech32m
      .encode(networkId, new DustAddress(dustSecret.publicKey))
      .toString(),
  };

  hd.hdWallet.clear();
  return bundle;
}
```

Notes:

- `Roles` is an enum of small integers exported from `@midnight-ntwrk/wallet-sdk-hd`. Pass them as a readonly tuple to `selectRoles`.
- `selectRoles` returns the keys in a record indexed by the role enum value, not by name.
- `hdWallet.clear()` zeroes secret material; call it once you've consumed the derived keys.
- `ZswapSecretKeys.fromSeed` and `ZswapSecretKeys.fromSeedRng` produce identical output for our use case.

## 3. Operation-to-address routing

For each operation, the column "Use" is the only correct address. The others either silently fail or send funds to a non-recoverable surface.

| Operation | Use | Why |
|---|---|---|
| Faucet HTTP POST `address` field | unshielded bech32m | Faucet always drops into the unshielded UTXO set |
| Lace Receive tab display | unshielded bech32m | Lace is unshielded-default for native NIGHT |
| Indexer GraphQL `transactions(...address: $a)` | unshielded bech32m | On-chain UTXO ownership keyed on unshielded |
| Native NIGHT send (recipient field) | unshielded bech32m | NIGHT lives unshielded |
| Public balance check (NIGHT) | unshielded bech32m | Indexer balance lookup uses bech32m |
| Shielded zswap tx, recipient `coinPublicKey` | shielded hex | zswap ledger uses raw 32-byte coin keys |
| HTLC Compact contract `sender` arg (Bytes<32>) | shielded hex | Contract receives raw 32-byte keys |
| HTLC Compact contract `receiver` arg (Bytes<32>) | shielded hex | Contract receives raw 32-byte keys |
| `dustReceiverAddress` arg to `registerNightUtxosForDustGeneration` | dust bech32m | Designation targets the dust public key |
| DUST balance lookup | dust bech32m | Dust ledger keyed on dust public key |
| `getWalletAddress()` backend call result | shielded hex (only) | Misleading name. See Section 4. |

Wrong-address symptoms:

- Faucet to shielded hex: faucet returns success, balance never increments. The shielded hex isn't valid as a faucet target on preview/preprod; some faucet implementations accept it format-wise but the drop goes nowhere.
- HTLC `receiver=unshielded bech32m`: contract instantiation fails because Compact's `Bytes<32>` arg refuses non-32-byte input.
- `dustReceiverAddress=unshielded bech32m`: `registerNightUtxosForDustGeneration` rejects with an address-type error.

## 4. Address normalization recipes

### Padding the shielded coin public key

The SDK returns `coinPublicKey` as a hex string of variable length. Always pad to 64 chars and prefix `0x`:

```typescript
function normalizeShieldedHex(raw: string | Uint8Array): string {
  let hex: string;
  if (typeof raw === 'string') {
    hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  } else {
    hex = Buffer.from(raw).toString('hex');
  }
  hex = hex.toLowerCase();
  if (!/^[a-f0-9]+$/.test(hex)) {
    throw new Error(`coinPublicKey not valid hex: ${raw}`);
  }
  if (hex.length > 64) {
    throw new Error(`coinPublicKey too long: ${hex.length} chars`);
  }
  return '0x' + hex.padStart(64, '0');
}
```

### Bech32m to raw bytes (for unshielded / dust)

Use the `MidnightBech32m.decode(networkId, bech32String)` helper from `@midnight-ntwrk/wallet-sdk-address-format`. It validates the checksum and returns the typed payload (an `UnshieldedAddress` or `DustAddress`); `.publicKey` exposes the underlying bytes.

There's no clean bech32m to shielded-hex conversion. The shielded role is a different keypair entirely.

## 5. Seed derivation gotcha

A 24-word BIP39 mnemonic is not a Midnight seed. It can be normalized three ways:

| Normalization | Bytes | Lace match? |
|---|---|---|
| `bip39.mnemonicToSeedSync(mnemonic, '')` | 64 | YES |
| First 32 of PBKDF2 output | 32 | NO |
| `bip39.mnemonicToEntropy(mnemonic)` | 32 | NO |

Lace uses `pbkdf2-full-64B`. Backend code MUST do the same or it derives different addresses from the "same" mnemonic.

To verify your seed normalization matches Lace's displayed addresses, run the bundled script (Section 7). It iterates over `{entropy-32, pbkdf2-full-64, pbkdf2-first32}` × `{fromSeed, fromSeedRng}` × `{(account, index) ∈ {(0,0), (0,1), (1,0), (1,1)}}` and prints all candidate triples. Match against what Lace displays.

## 6. Diagnostic recipes

### "I sent the faucet 5 NIGHT and my balance is still 0"

Six steps. Stop at the first one that explains it.

1. Confirm sync is complete. Cold sync on preprod can run >30 min. The faucet drop is on-chain but your wallet hasn't seen it yet.
   ```bash
   curl -H "x-midnight-sidecar-token: $TOKEN" http://127.0.0.1:8090/wallet/diagnostics | jq '.isSynced, .progress.unshielded'
   ```
   If `isSynced: false`, just wait.

2. Confirm you sent the faucet to the right address. Look at the faucet's response and compare to `addresses.unshieldedAddress`:
   ```bash
   curl -H "x-midnight-sidecar-token: $TOKEN" http://127.0.0.1:8090/wallet/diagnostics | jq '.addresses'
   ```
   If you posted the shielded hex (`0x...`) to a faucet expecting bech32m, the drop went nowhere.

3. Confirm the faucet acknowledged. The web faucet returns a tx hash. Query the indexer for that tx:
   ```bash
   curl -X POST $MIDNIGHT_INDEXER_URL \
     -H 'Content-Type: application/json' \
     -d '{"query":"query { transactions(offset: { hash: \"<txhash>\" }) { id block { height } } }"}'
   ```
   Empty result means faucet failed silently. Refile.

4. Confirm your seed normalization matches Lace. Run the bundled script (Section 7). If your derived bech32m differs from what Lace shows for the same mnemonic, you have a normalization bug; the faucet went to a real address, just not the one your backend thinks it owns.

5. Confirm the address belongs to the right account/index. Default is `account=0, index=0`. Some Lace flows roll the index. Check the script output for an `(account, index)` row that matches.

6. Confirm network match. A preview faucet drop never appears in a preprod wallet, and vice versa. Sanity-check `addresses.unshieldedAddress` prefix: `mn_addr_preview1...` for preview, `mn_addr_preprod1...` for preprod.

### "Lace shows X tNIGHT but my backend reports 0"

Either sync is not complete (recipe 1 above), or the seed normalization differs (Section 5). The two wallets are looking at different on-chain addresses.

### "I ran `getWalletAddress()` and got a hex string, but Lace shows bech32m. Are these the same wallet?"

Yes. `getWalletAddress()` returns only the shielded coin public key. Lace shows the unshielded bech32m. Same seed, different roles. Expose all three on a diagnostics endpoint and pick by use case.

## 7. Use the bundled script

`scripts/address-derive.mjs` is the standalone tool for this. Pass either `--seed <hex>` or `--mnemonic "<24 words>"` and the network id.

```bash
node scripts/address-derive.mjs \
  --network preview \
  --mnemonic "regular all limb potato vast artist slide select primary seminar screen own drill boat april special comfort basket lens response wise flock foster urge"
```

Expected output:

```json
{
  "networkId": "preview",
  "account": 0,
  "index": 0,
  "addresses": {
    "shieldedCoinPublicKey": "0x4f1c...3a9b",
    "unshieldedAddress": "mn_addr_preview1qwerty...",
    "dustAddress": "mn_dust_preview1asdfg..."
  }
}
```

Exit code: `0` on success, `1` on derivation failure, `2` on argument error.

## See also

- `wallet-lifecycle.md` — what to do once you have addresses (sync, deploy, submit).
- `dust-night-registration.md` — getting DUST credited to your dust address.
- `network-chooser.md` — preview vs preprod and the cloud-IP block.
