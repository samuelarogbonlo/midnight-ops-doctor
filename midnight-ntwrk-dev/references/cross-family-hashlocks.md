# cross-family-hashlocks

> When to use this doc: you are wiring an HTLC between Midnight and an EVM chain (or any non-Compact chain) and the hashlocks must agree, OR you are debugging a swap where the EVM withdraw works but Midnight withdraw fails with "Invalid preimage", OR you upgraded the SDK and persistentHash output changed.

## Contents

- 1. The cross-family problem
- 2. The Compact primitive
- 3. The golden-vector self-test
- 4. The EVM side: `_SHA256` HTLC variants
- 5. Common mismatches
- 6. Self-test invocation
- 7. Diagnostic recipes
- See also

## 1. The cross-family problem

Midnight Compact's natural hash primitive is `persistentHash<T>(value)`. Under the hood for `T = Bytes<32>` it produces a standard SHA-256 of the 32 raw bytes; no length prefix, no type tag, no domain separation.

EVM's natural hash is keccak256 (`abi.encodePacked` + `keccak256`). EVM HTLCs default to keccak hashlocks. SHA-256 and keccak256 are entirely different functions; there is no preimage that hashes to the same digest under both.

For a Midnight ↔ EVM atomic swap to settle, both sides must agree on SHA-256 as the hash function. Compact's persistentHash is fixed, so the EVM side has to be the one that adapts.

## 2. The Compact primitive

In a Compact HTLC contract, the verification looks like:

```compact
const computedHash = persistentHash<Bytes<32>>(preimage);
assert(computedHash == hashlock.read(), "Invalid preimage");
```

For the off-chain side that computes the hashlock to register on chain, the equivalent runtime call is:

```typescript
import { persistentHash, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';

const bytes = hexToBytes(preimage);
const sdkHash = persistentHash(new CompactTypeBytes(32), bytes);
const hashlock = '0x' + Buffer.from(sdkHash).toString('hex');
```

The `CompactTypeBytes(32)` argument is the type encoder. For a 32-byte input that's the entire encoding (no length prefix because the type has fixed length), so `persistentHash(CompactTypeBytes(32), bytes)` produces exactly `SHA-256(bytes)`. That equivalence is what cross-family parity depends on.

## 3. The golden-vector self-test

Don't trust this equivalence at runtime. Verify it at boot. A self-test on adapter init hashes two fixed 32-byte vectors:

| Vector | Input | Expected SHA-256 |
|---|---|---|
| zero-bytes-32 | 32 × 0x00 | `0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925` |
| ones-bytes-32 | 32 × 0xff | `0xaf9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051` |

If `persistentHash(CompactTypeBytes(32), bytes)` for either vector doesn't byte-for-byte equal the Node `crypto.createHash('sha256')` digest, throw at init and refuse to mark the adapter operational. Fail-closed by design.

`computeHashlock` itself is also fail-closed: if the runtime is not loaded, throw rather than silently fall back to Node SHA-256. Falling back would be unobservable to the caller and would produce an unredeemable HTLC.

## 4. The EVM side: `_SHA256` HTLC variants

Standard `createSourceHTLCWithPermit` uses keccak hashlocks. For Midnight ↔ EVM swaps you must use the SHA-256 variant `createSourceHTLCWithPermit_SHA256`. The variant is a byte-mirror of the keccak version with two differences:

1. `htlcHashType[htlcId] = HashType.SHA256` switches the on-chain `withdraw()` dispatcher to verify with SHA-256.
2. An extra `HTLCCreatedSHA256` event so the indexer can distinguish corridors at event-replay time.

For ETH (no Permit2 path) and for destination-side locks, the parallel SHA-256 variants are `createSourceHTLC_SHA256` and `createDestinationHTLC_SHA256`.

The solver-side dispatcher decides which variant to call based on the corridor:

```typescript
const hashFunction = getHashFunctionForRoute(srcChain, dstChain);
// 'sha256' for any cross-family pair (Midnight in either leg).
// 'keccak256' for EVM ↔ EVM same-family swaps.

if (hashFunction === 'sha256') {
  await htlc.createSourceHTLCWithPermit_SHA256(
    sender, receiver, hashlock, token, amount, intentId,
    permitNonce, permitDeadline, permitSignature,
  );
} else {
  await htlc.createSourceHTLCWithPermit(
    sender, receiver, hashlock, token, amount, intentId,
    permitNonce, permitDeadline, permitSignature,
  );
}
```

Same dispatch on the destination side and on the no-Permit ETH variants.

## 5. Common mismatches

### Wrong type encoder

```typescript
// WRONG. CompactTypeBytes(64) prepends a length prefix because the
// stored value (32 bytes) is shorter than the declared type. Output is
// SHA-256(prefix || bytes), which does not match anything an EVM side
// would compute.
persistentHash(new CompactTypeBytes(64), bytes32);

// CORRECT. Fixed-length encoder for the actual byte length.
persistentHash(new CompactTypeBytes(32), bytes32);
```

### Wrong hash primitive

`persistentHash` is one of three hash primitives in the Compact runtime:

| Primitive | Use |
|---|---|
| `persistentHash` | Long-lived public commitments; what HTLCs use. SHA-256 for Bytes<32>. |
| `nativeHash` | Internal Compact protocol use; not a stable cross-chain primitive. |
| `transientHash` | Per-transaction throwaway; output not portable. |

Using `nativeHash` or `transientHash` here will compile but produce a non-SHA-256 digest and the cross-chain side will reject the preimage on withdraw.

### Endian mismatch on Uint<64>

Compact's `Uint<64>` is little-endian variable-length when serialized into a `persistentHash` input. EVM keccak/SHA expects big-endian fixed 8-byte. If your hashlock derivation involves a numeric field (e.g. hashlock = SHA-256(secret || amount)), the two sides will hash different byte sequences.

Fix: encode all numerics manually to a fixed 8-byte big-endian Buffer on the EVM side and a 32-byte left-padded Bytes on the Compact side, then SHA-256 those. Don't feed the Uint<64> directly to persistentHash if cross-family parity matters.

### Bit-decomposition mismatch in the circuit

If you wrote a custom Compact circuit that does its own bit decomposition before SHA-256 (e.g. for a Merkle-tree leaf), the off-chain Node-side computation must mirror that exact decomposition. The vanilla HTLC contract pattern hashes raw bytes, so this mismatch only applies to forks that customize the circuit.

## 6. Self-test invocation

The boot-time self-test is mandatory. To run it standalone (e.g. from a CI smoke script before deploying), invoke the adapter's exposed accessor:

```typescript
import { MidnightHTLCAdapter } from './adapters/midnight/MidnightHTLCAdapter';

const adapter = new MidnightHTLCAdapter(config);
await adapter.initialize();

if (!adapter.getPersistentHashSelfTestPassed()) {
  // initialize() throws on mismatch, so this should never be reachable,
  // but be paranoid in CI.
  throw new Error('persistentHash self-test did not pass');
}
console.log('persistentHash parity with Node SHA-256: verified');
```

For an even-more-isolated verification (no adapter, no full SDK init), hash both vectors directly via Node and compare against the table in Section 3:

```typescript
import { createHash } from 'crypto';

const zero32 = new Uint8Array(32);
const ones32 = new Uint8Array(32).fill(0xff);

console.log('zero:', createHash('sha256').update(zero32).digest('hex'));
// 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
console.log('ones:', createHash('sha256').update(ones32).digest('hex'));
// af9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051
```

Any divergence here means your Node `crypto` is broken, which has never been observed. The risk lives entirely on the Compact runtime side, which is why the boot-time test compares Compact output against Node output.

The bundled `scripts/persistent-hash-self-test.mjs` runs both vectors as a standalone CLI. Use it from CI or as a sanity check after any SDK upgrade.

## 7. Diagnostic recipes

### "My Compact contract rejects the preimage with 'Invalid preimage'"

1. Print the on-chain hashlock from the contract state. Compare against what your off-chain side stored at lock time.
2. Print the preimage you are submitting. Compute SHA-256(preimage) via Node and confirm it equals the on-chain hashlock.
3. If they don't match, your hashlock derivation differs between producer and consumer. Common causes:
   - Producer used keccak256, consumer expects SHA-256 (or vice versa).
   - Producer hashed UTF-8 string bytes; consumer hashed hex-decoded bytes.
   - Producer included a length prefix that consumer did not.
4. If they do match, the runtime is corrupted. Re-run `getPersistentHashSelfTestPassed()`. If false, the SDK upgrade broke parity. Pin to the previous SDK version and file an upstream bug.

### "EVM withdraw works but Midnight withdraw fails"

You're using a keccak hashlock, not SHA-256. The EVM HTLC accepted it because you called the keccak variant; the Midnight contract is hardcoded to SHA-256 and will never accept a keccak preimage.

Fix: re-lock the source HTLC using `createSourceHTLCWithPermit_SHA256` (or the ETH/no-Permit equivalent), with a hashlock derived as `SHA-256(preimage)`. The corridor selector should set this automatically; if it didn't, your route definition lacks `hashFunction: 'sha256'` for the cross-family pair.

### "The hashlock I submit and the hashlock the contract computes differ"

Run the persistentHash self-test. If the boot-time vectors pass but your runtime hashlock differs, the divergence is in the input bytes, not the hash function. Print the raw 32-byte preimage hex on both sides before hashing, and confirm byte-for-byte equality. The most common cause is an off-by-one in hex decoding (a leading `0x` consumed once on one side, twice on the other) or a stripped trailing zero.

## See also

- `references/symptom-catalog.md` — `err-persistent-hash-mismatch`
- `references/version-matrix.md` — which proof-server / ledger versions preserve persistentHash semantics
- `references/wallet-lifecycle.md` — `initialize()` ordering (self-test runs inside initialize())
