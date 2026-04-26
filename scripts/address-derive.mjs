#!/usr/bin/env node
// After saving, run: chmod +x address-derive.mjs
//
// address-derive.mjs
// ------------------
// Derive all THREE Midnight addresses from a 32-byte (64-char hex) seed:
//   1. Zswap shielded coinPublicKey  -- 0x + 64 hex (used for shielded tokens)
//   2. NightExternal bech32m address -- mn_addr_<network>1...   (NIGHT/UTXO)
//   3. Dust public key (bech32m)     -- mn_dust_<network>1...   (DUST credits)
//
// Modeled on the canonical production derivation pattern: HDWallet.fromSeed(seed)
// .selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
// .deriveKeysAt(0). See references/three-addresses.md for the full pattern.
//
// SEED-DERIVATION GOTCHA:
//   Lace produces a 64-byte BIP39 PBKDF2 seed and uses ALL 64 bytes (`pbkdf2-full-64byte`).
//   Mnemonic-entropy-32 and pbkdf2-first-32 do NOT match Lace's derived addresses.
//   This script accepts a hex seed directly; if you have a mnemonic, run
//   `bip39.mnemonicToSeedSync(mnemonic, '').toString('hex')` first to get the
//   full 128-char hex (the pbkdf2-full-64-byte form).
//
// PACKAGE NOTE:
//   `@midnight-ntwrk/wallet-sdk-hd` and `@midnight-ntwrk/ledger-v8` are ESM-only.
//   This script is `.mjs` so dynamic `import()` works without ERR_UNSUPPORTED_DIR_IMPORT.

import process, { argv, stderr, stdout } from 'node:process';
import { Buffer } from 'node:buffer';
// NOTE: `exitCode` is a writable property on the `process` object; the named
// ESM export from `node:process` is a read-only snapshot. We must assign to
// `process.exitCode` (NOT a destructured `exitCode` binding) for the value to
// stick, and we deliberately avoid `process.exit()` so the event loop drains.

// ---------------------------------------------------------------------------
// Named constants (no magic values)
// ---------------------------------------------------------------------------
export const SEED_HEX_LENGTH_32B = 64;   // 32-byte seed encoded as hex
export const SEED_HEX_LENGTH_64B = 128;  // 64-byte (pbkdf2-full) seed encoded as hex
export const ACCOUNT_INDEX = 0;
export const ADDRESS_INDEX = 0;
export const SUPPORTED_NETWORKS = Object.freeze(['preview', 'preprod']);
export const DEFAULT_NETWORK = 'preview';

// Exit codes
export const EXIT_OK = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_BAD_INPUT = 2;
export const EXIT_DEP_MISSING = 3;

const HEX_RE = /^[0-9a-fA-F]+$/;

const USAGE = `\
Usage:
  node address-derive.mjs --seed-from-stdin [--network preview|preprod]
  node address-derive.mjs <seed-hex>         [--network preview|preprod]   (deprecated, leaks seed)
  node address-derive.mjs --help

Args:
  --seed-from-stdin      Read the seed hex from stdin (recommended). Trailing
                         whitespace/newlines are trimmed.
  <seed-hex>             32-byte (64 hex chars) or 64-byte (128 hex chars) seed.
                         Lace-compatible seeds are pbkdf2-full-64-byte (128 hex chars).
                         WARNING: passing the seed in argv leaks it to /proc, ps,
                         shell history, and audit logs. Prefer --seed-from-stdin.
  --network <name>       Midnight network ID (preview|preprod). Default: ${DEFAULT_NETWORK}.

Examples:
  echo "$MIDNIGHT_SEED" | node address-derive.mjs --seed-from-stdin
  node address-derive.mjs --seed-from-stdin < seed.txt

Output:
  JSON object on stdout with keys:
    zswapCoinPublicKey   -- 0x + 64-hex shielded coin public key
    nightExternalAddress -- mn_addr_<network>1... bech32m unshielded address
    dustPublicKey        -- mn_dust_<network>1... bech32m dust public key

Exit codes:
  0  success
  1  runtime/derivation failure
  2  bad CLI input (invalid seed/network)
  3  required Midnight SDK package is not installed
`;

function printUsage(stream = stdout) {
  stream.write(USAGE);
}

function parseArgs(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }

  const positional = [];
  let network = DEFAULT_NETWORK;
  let seedFromStdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--network') {
      const next = args[i + 1];
      if (!next) throw new Error('--network requires a value (preview|preprod)');
      network = next;
      i++;
    } else if (arg.startsWith('--network=')) {
      network = arg.slice('--network='.length);
    } else if (arg === '--seed-from-stdin') {
      seedFromStdin = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!SUPPORTED_NETWORKS.includes(network)) {
    throw new Error(`--network must be one of {${SUPPORTED_NETWORKS.join(',')}}; got '${network}'`);
  }

  if (seedFromStdin) {
    if (positional.length !== 0) {
      throw new Error('--seed-from-stdin is incompatible with positional <seed-hex>');
    }
    return { seedFromStdin: true, network };
  }

  if (positional.length !== 1) {
    throw new Error(
      `Expected exactly 1 positional arg (seed hex) or --seed-from-stdin; got ${positional.length} positional`,
    );
  }

  const seedHex = positional[0].trim().replace(/^0x/i, '');
  return { seedHex, network, fromArgv: true };
}

async function readSeedFromStdin() {
  // Refuse to block forever when stdin is a TTY — operator probably forgot
  // to pipe input.
  if (process.stdin.isTTY) {
    throw new Error(
      '--seed-from-stdin requires piped input (e.g. `echo "$SEED" | ...` or `... < seed.txt`)',
    );
  }
  process.stdin.setEncoding('utf8');
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  const seedHex = buf.trim().replace(/^0x/i, '');
  if (seedHex.length === 0) {
    throw new Error('--seed-from-stdin received empty input');
  }
  return seedHex;
}

function validateSeedHex(seedHex) {
  if (!HEX_RE.test(seedHex)) {
    throw new Error(`seed must be hex; non-hex characters present`);
  }
  if (seedHex.length !== SEED_HEX_LENGTH_32B && seedHex.length !== SEED_HEX_LENGTH_64B) {
    throw new Error(
      `seed must be ${SEED_HEX_LENGTH_32B} or ${SEED_HEX_LENGTH_64B} hex chars ` +
      `(32-byte or 64-byte pbkdf2-full); got ${seedHex.length}`,
    );
  }
}

async function loadSdk() {
  // Dynamic imports give us a clean exit-3 path with an installation hint
  // instead of an opaque ERR_MODULE_NOT_FOUND stack trace.
  let hd, ledger, networkIdMod;
  try {
    hd = await import('@midnight-ntwrk/wallet-sdk-hd');
  } catch (err) {
    const e = new Error('Missing dependency @midnight-ntwrk/wallet-sdk-hd');
    e.cause = err;
    e.installHint = 'npm i @midnight-ntwrk/wallet-sdk-hd';
    e.exitCode = EXIT_DEP_MISSING;
    throw e;
  }
  try {
    ledger = await import('@midnight-ntwrk/ledger-v8');
  } catch (err) {
    const e = new Error('Missing dependency @midnight-ntwrk/ledger-v8');
    e.cause = err;
    e.installHint = 'npm i @midnight-ntwrk/ledger-v8';
    e.exitCode = EXIT_DEP_MISSING;
    throw e;
  }
  try {
    networkIdMod = await import('@midnight-ntwrk/midnight-js-network-id');
  } catch (err) {
    const e = new Error('Missing dependency @midnight-ntwrk/midnight-js-network-id');
    e.cause = err;
    e.installHint = 'npm i @midnight-ntwrk/midnight-js-network-id';
    e.exitCode = EXIT_DEP_MISSING;
    throw e;
  }

  let unshieldedMod;
  try {
    unshieldedMod = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
  } catch (err) {
    const e = new Error('Missing dependency @midnight-ntwrk/wallet-sdk-unshielded-wallet');
    e.cause = err;
    e.installHint = 'npm i @midnight-ntwrk/wallet-sdk-unshielded-wallet';
    e.exitCode = EXIT_DEP_MISSING;
    throw e;
  }

  return {
    HDWallet: hd.HDWallet,
    Roles: hd.Roles,
    ZswapSecretKeys: ledger.ZswapSecretKeys,
    DustSecretKey: ledger.DustSecretKey,
    MidnightBech32m: ledger.MidnightBech32m,
    DustAddress: ledger.DustAddress,
    setNetworkId: networkIdMod.setNetworkId,
    getNetworkId: networkIdMod.getNetworkId,
    createKeystore: unshieldedMod.createKeystore,
  };
}

function deriveAll({ seedHex, network, sdk }) {
  const seedBytes = new Uint8Array(Buffer.from(seedHex, 'hex'));

  // Network ID is GLOBAL state in @midnight-ntwrk/midnight-js-network-id.
  // We must set it before encoding any bech32m address so the HRP
  // ("mn_addr_preview" vs "mn_addr_preprod") is correct.
  sdk.setNetworkId(network);

  const hdResult = sdk.HDWallet.fromSeed(seedBytes);
  if (hdResult.type !== 'seedOk') {
    throw new Error(
      `HD wallet seed error: type='${hdResult.type}'` +
      (hdResult.error ? ` error='${String(hdResult.error)}'` : ''),
    );
  }

  const derived = hdResult.hdWallet
    .selectAccount(ACCOUNT_INDEX)
    .selectRoles([sdk.Roles.Zswap, sdk.Roles.NightExternal, sdk.Roles.Dust])
    .deriveKeysAt(ADDRESS_INDEX);
  if (derived.type !== 'keysDerived') {
    throw new Error(`HD key derivation failed: type='${derived.type}'`);
  }

  const zswapKeys = sdk.ZswapSecretKeys.fromSeed(derived.keys[sdk.Roles.Zswap]);
  const dustSecretKey = sdk.DustSecretKey.fromSeed(derived.keys[sdk.Roles.Dust]);
  const unshieldedKeystore = sdk.createKeystore(
    derived.keys[sdk.Roles.NightExternal],
    sdk.getNetworkId(),
  );

  // coinPublicKey may already be 0x-prefixed depending on SDK version.
  const rawCoinPubKey = String(zswapKeys.coinPublicKey);
  const zswapCoinPublicKey = rawCoinPubKey.startsWith('0x')
    ? rawCoinPubKey.toLowerCase()
    : '0x' + rawCoinPubKey.toLowerCase();

  const nightExternalAddress = unshieldedKeystore.getBech32Address().toString();
  const dustPublicKey = sdk.MidnightBech32m
    .encode(sdk.getNetworkId(), new sdk.DustAddress(dustSecretKey.publicKey))
    .toString();

  // Free HD wallet material from memory (it holds derived bytes).
  try {
    hdResult.hdWallet.clear();
  } catch {
    // clear() may not exist on older SDKs; non-fatal.
  }

  return { zswapCoinPublicKey, nightExternalAddress, dustPublicKey };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(argv.slice(2));
  } catch (err) {
    stderr.write(`ERROR: ${err.message}\n\n`);
    printUsage(stderr);
    process.exitCode = EXIT_BAD_INPUT;
    return;
  }
  if (parsed.help) {
    printUsage(stdout);
    process.exitCode = EXIT_OK;
    return;
  }

  let seedHex = parsed.seedHex;
  if (parsed.seedFromStdin) {
    try {
      seedHex = await readSeedFromStdin();
    } catch (err) {
      stderr.write(`ERROR: ${err.message}\n`);
      process.exitCode = EXIT_BAD_INPUT;
      return;
    }
  } else if (parsed.fromArgv) {
    // Seed-via-argv leaks to /proc/$pid/cmdline, ps -ef, shell history, and
    // audit logs. Loud one-line warning so the operator knows; not a failure
    // (back-compat with prior invocation pattern).
    stderr.write(
      'WARN: seed passed via argv leaks to /proc, ps, shell history, audit logs.\n' +
      'WARN: Prefer `--seed-from-stdin`. See `--help`.\n',
    );
  }

  try {
    validateSeedHex(seedHex);
  } catch (err) {
    stderr.write(`ERROR: ${err.message}\n`);
    process.exitCode = EXIT_BAD_INPUT;
    return;
  }

  let sdk;
  try {
    sdk = await loadSdk();
  } catch (err) {
    stderr.write(`ERROR: ${err.message}\n`);
    if (err.installHint) stderr.write(`HINT:  ${err.installHint}\n`);
    if (err.cause) stderr.write(`CAUSE: ${err.cause.message}\n`);
    process.exitCode = err.exitCode ?? EXIT_RUNTIME_ERROR;
    return;
  }

  try {
    const result = deriveAll({ seedHex, network: parsed.network, sdk });
    stdout.write(JSON.stringify({ network: parsed.network, ...result }, null, 2) + '\n');
    process.exitCode = EXIT_OK;
  } catch (err) {
    stderr.write(`ERROR: derivation failed: ${err.message}\n`);
    if (err.cause) stderr.write(`CAUSE: ${err.cause.message ?? String(err.cause)}\n`);
    process.exitCode = EXIT_RUNTIME_ERROR;
  }
}

await main();
