#!/usr/bin/env node
// After saving, run: chmod +x persistent-hash-self-test.mjs
//
// persistent-hash-self-test.mjs
// -----------------------------
// Standalone golden-vector self-test mirroring the boot-time
// `assertPersistentHashReady()` pattern in a wallet adapter. See
// references/cross-family-hashlocks.md for context.
//
// Why this exists:
//   The Midnight HTLC contract verifies hashlocks via Compact's
//   `persistentHash(CompactTypeBytes(32), bytes)`. The backend computes
//   hashlocks the same way, with a Node.js SHA-256 cross-check. This script
//   is the same self-test, but bundle-free and runnable in any directory.
//
//   If the SDK is installed, it runs the full SDK-vs-Node parity check.
//   If the SDK is NOT installed, it prints the Node SHA-256 baselines so
//   operators have reference values to compare against.
//
// Expected golden values (verifiable: `echo -n -e '\x00\x00...'  | sha256sum`):
//   SHA-256(zero32) = 0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
//   SHA-256(ones32) = 0xaf9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051

import process, { argv, stderr, stdout } from 'node:process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
// NOTE: `exitCode` is a writable property on the `process` object; the named
// ESM export from `node:process` is read-only. Assign to `process.exitCode`
// (NOT a destructured binding) and avoid `process.exit()` so the event loop drains.

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------
export const VECTOR_BYTE_LENGTH = 32; // CompactTypeBytes(32) -- HTLC hashlock width

// Pinned expected SHA-256 outputs. Rebuilds of @midnight-ntwrk/compact-runtime
// must continue to produce these for `persistentHash(CompactTypeBytes(32), b)`,
// or shielded HTLCs become unredeemable. These are also defensive baselines:
// even if the Midnight runtime is unavailable, operators have ground truth to
// compare against any other implementation.
export const EXPECTED_SHA256_ZERO32 =
  '0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';
export const EXPECTED_SHA256_ONES32 =
  '0xaf9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051';

// Exit codes
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_BAD_INPUT = 2;

const USAGE = `\
Usage:
  node persistent-hash-self-test.mjs
  node persistent-hash-self-test.mjs --help

Behavior:
  - Computes Node.js SHA-256 for two fixed 32-byte vectors (all 0x00, all 0xff)
    and asserts each matches the pinned golden value.
  - If @midnight-ntwrk/compact-runtime is installed, also computes
    persistentHash(CompactTypeBytes(32), bytes) for each vector and asserts
    byte-for-byte parity with Node SHA-256. Any mismatch => exit 1.
  - If the SDK is NOT installed, the script prints Node baselines and exits 0
    (informational, not a test failure).

Exit codes:
  0  PASS (or SDK absent and Node baselines correct -- informational)
  1  FAIL (golden mismatch, SDK divergence, or Node crypto unavailable)
  2  bad CLI input
`;

function printUsage(stream = stdout) {
  stream.write(USAGE);
}

function nodeSha256Hex(bytes) {
  return '0x' + createHash('sha256').update(bytes).digest('hex');
}

async function tryLoadSdk() {
  try {
    const mod = await import('@midnight-ntwrk/compact-runtime');
    if (typeof mod.persistentHash !== 'function' || typeof mod.CompactTypeBytes !== 'function') {
      throw new Error(
        'compact-runtime loaded but persistentHash / CompactTypeBytes are not callable',
      );
    }
    return { persistentHash: mod.persistentHash, CompactTypeBytes: mod.CompactTypeBytes };
  } catch (err) {
    return { error: err };
  }
}

function buildVectors() {
  return [
    {
      label: 'zero-bytes-32',
      bytes: new Uint8Array(VECTOR_BYTE_LENGTH), // all 0x00
      expected: EXPECTED_SHA256_ZERO32,
    },
    {
      label: 'ones-bytes-32',
      bytes: new Uint8Array(VECTOR_BYTE_LENGTH).fill(0xff),
      expected: EXPECTED_SHA256_ONES32,
    },
  ];
}

async function main() {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage(stdout);
    process.exitCode = EXIT_OK;
    return;
  }
  if (args.length > 0) {
    stderr.write(`ERROR: unexpected arguments: ${args.join(' ')}\n\n`);
    printUsage(stderr);
    process.exitCode = EXIT_BAD_INPUT;
    return;
  }

  const sdk = await tryLoadSdk();
  const sdkLoaded = !sdk.error;

  stdout.write('Midnight persistentHash self-test\n');
  stdout.write('=================================\n\n');

  let allPass = true;
  let goldenMismatch = false;

  for (const { label, bytes, expected } of buildVectors()) {
    let nodeHex;
    try {
      nodeHex = nodeSha256Hex(bytes);
    } catch (err) {
      stderr.write(`FATAL: Node crypto failed for vector='${label}': ${err.message}\n`);
      process.exitCode = EXIT_FAIL;
      return;
    }

    stdout.write(`Vector: ${label}\n`);
    stdout.write(`  Expected SHA-256:        ${expected}\n`);
    stdout.write(`  Node SHA-256:            ${nodeHex}\n`);
    if (nodeHex !== expected) {
      stdout.write('  Result: FAIL (Node SHA-256 does not match pinned golden value)\n\n');
      goldenMismatch = true;
      allPass = false;
      continue;
    }

    if (sdkLoaded) {
      let sdkHex;
      try {
        const out = sdk.persistentHash(new sdk.CompactTypeBytes(VECTOR_BYTE_LENGTH), bytes);
        sdkHex = '0x' + Buffer.from(out).toString('hex');
      } catch (err) {
        stdout.write(`  Midnight persistentHash: <threw: ${err.message}>\n`);
        stdout.write('  Result: FAIL (persistentHash threw)\n\n');
        allPass = false;
        continue;
      }
      stdout.write(`  Midnight persistentHash: ${sdkHex}\n`);
      if (sdkHex === nodeHex) {
        stdout.write('  Result: PASS\n\n');
      } else {
        stdout.write('  Result: FAIL (persistentHash diverges from Node SHA-256)\n\n');
        allPass = false;
      }
    } else {
      stdout.write('  Midnight persistentHash: <SDK not loaded -- skipped>\n');
      stdout.write('  Result: PASS (Node baseline matches golden)\n\n');
    }
  }

  if (!sdkLoaded) {
    stdout.write(
      'Note: @midnight-ntwrk/compact-runtime is not installed in this environment.\n' +
      'Install it (npm i @midnight-ntwrk/compact-runtime) to run the full SDK-vs-Node\n' +
      'parity check. Without it, only the Node SHA-256 baselines were verified.\n\n',
    );
  }

  if (goldenMismatch) {
    stderr.write(
      'CRITICAL: Node SHA-256 disagrees with the pinned golden value. This means ' +
      'either Node crypto is broken in this environment OR the golden constants ' +
      'in this script were edited incorrectly. Investigate before trusting any ' +
      'hashlock computed here.\n',
    );
  }

  stdout.write(`Self-test: ${allPass ? 'PASS' : 'FAIL'}\n`);
  process.exitCode = allPass ? EXIT_OK : EXIT_FAIL;
}

await main();
