#!/usr/bin/env node
/**
 * Midnight + EVM Deploy Verifier — fail-closed bidirectional post-deploy check.
 *
 * Headline check (#5): Groth16 verification-key byte-equality between local zkey
 * and deployed contract bytecode. Catches the vk-mismatch bug class that has
 * lost real protocols real funds (FOOM Club, Veil Protocol, and the project's
 * own SettlementVerifier on 2026-04-25 — see MEMORY.md "SettlementVerifier vk
 * mismatch (Bug 5)").
 *
 * Exit code = number of FAIL checks. CI gates on this.
 *
 * Usage: node deploy-verifier.mjs <path-to-deploy-manifest.json>
 *
 * Schema: see assets/deploy-manifest.example.json. Each top-level section is
 * optional; a check whose section is absent reports SKIP.
 *
 * References:
 *   - vk-mismatch bug class:        references/groth16-vk-mismatch.md
 *   - genesis hash + indexer:        references/network-chooser.md
 *   - sidecar diagnostics shape:     references/wallet-lifecycle.md
 *   - DUST registration:             references/dust-night-registration.md
 *   - proof-server version matrix:   references/version-matrix.md
 *   - cloud-IP block (AWS ELB 403):  references/network-chooser.md § Cloud-IP
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Prefer execFile over exec — argv array is passed verbatim, no shell, no
// metacharacter injection from manifest-controlled paths. Critical because
// localZkeyPath flows from a (possibly attacker-influenced) manifest into
// the snarkjs CLI invocation.
const execFile = promisify(execFileCb);

// =====================================================================
// Hardened URL + env-var validation
// =====================================================================

// Only http(s) and ws(s) are allowed for any manifest-supplied URL. Blocks
// file://, gopher://, data:, javascript:, etc. — both for SSRF and for local
// file disclosure via fetch().
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function assertSafeUrl(rawUrl, fieldName, { allowWs = false } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new Error(`${fieldName} is empty or not a string`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error(`${fieldName} is not a valid URL`);
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${fieldName} has disallowed protocol "${parsed.protocol}" (only http/https/ws/wss permitted)`);
  }
  if (!allowWs && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')) {
    throw new Error(`${fieldName} must be http/https, not ws/wss`);
  }
  // Reject embedded credentials — keeps secrets out of CI logs if URL is
  // ever echoed in an error message.
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} contains embedded credentials; use a token env var instead`);
  }
  return parsed;
}

// Env-var names follow POSIX convention. Reject anything that could be used
// to siphon arbitrary process env (e.g. PATH, HOME, AWS_SECRET_ACCESS_KEY).
// We allow any well-formed name, but require the manifest to be explicit.
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

function assertValidEnvVarName(name, fieldName) {
  if (typeof name !== 'string' || !ENV_VAR_NAME_RE.test(name)) {
    throw new Error(`${fieldName} must match ${ENV_VAR_NAME_RE} (got: ${typeof name === 'string' ? JSON.stringify(name) : typeof name})`);
  }
}

// Redact any URL appearing in a free-form error message — replace host with
// scheme + "[redacted-host]". CI logs may be public; manifest URLs may not be.
function redactUrlsInString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\b(https?|wss?):\/\/[^\s'"<>]+/gi, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//[redacted-host]${u.pathname || ''}`;
    } catch {
      return '[redacted-url]';
    }
  });
}

// =====================================================================
// Output formatting
// =====================================================================

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' };
const COLOR = process.stdout.isTTY ? {
  PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m', SKIP: '\x1b[90m',
  reset: '\x1b[0m', bold: '\x1b[1m',
} : { PASS: '', FAIL: '', WARN: '', SKIP: '', reset: '', bold: '' };

function fmtStatus(s) {
  return `${COLOR[s] || ''}${s.padEnd(4)}${COLOR.reset}`;
}

function printCheck(idx, total, name, status, detail, extraLines = []) {
  const dots = '.'.repeat(Math.max(2, 36 - name.length));
  console.log(`[${idx}/${total}] ${name} ${dots} ${fmtStatus(status)}  ${detail}`);
  for (const line of extraLines) {
    console.log(`                                              ${line}`);
  }
}

// =====================================================================
// Manifest loading + validation
// =====================================================================

// Cap manifest size at 64 KiB. Real manifests are <2 KiB; anything larger is
// either operator error or hostile input designed to OOM the loader.
const MAX_MANIFEST_BYTES = 64 * 1024;

function loadManifest(path) {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`Manifest is not a regular file: ${redactPath(path)}`);
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Manifest too large: ${stat.size} bytes (max ${MAX_MANIFEST_BYTES})`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Manifest is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manifest must be a JSON object');
  }
  if (!parsed.network || typeof parsed.network !== 'string') {
    throw new Error('Manifest.network is required (string)');
  }
  return parsed;
}

// Resolve a path relative to the manifest file's directory if not absolute.
function resolveLocalPath(rawPath, manifestPath) {
  if (isAbsolute(rawPath)) return rawPath;
  return resolve(dirname(manifestPath), rawPath);
}

// Redact absolute paths in error strings emitted to stdout (CI logs may be
// public). Replace with basename only.
function redactPath(p) {
  if (!p) return p;
  return basename(p);
}

// Redact absolute filesystem paths embedded inside a free-form error string —
// e.g. "ENOENT: no such file or directory, open '/Users/x/y/z.zkey'". Replace
// each absolute path with its basename. POSIX absolute paths only; Windows
// is best-effort. Used for stderr from child processes and runtime errors.
function redactAbsolutePathsInString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/(['"]?)(\/[\w./@+-]+)(['"]?)/g, (_m, q1, p, q2) => {
    return `${q1}${basename(p)}${q2}`;
  });
}

// =====================================================================
// Check 1: Wallet sync-completion (Midnight sidecar)
// =====================================================================

// Sidecar is a localhost-only diagnostic endpoint. Pinning it to loopback
// prevents an attacker-supplied manifest from siphoning the env-resolved
// token (or PATH/HOME if the attacker abuses diagnosticsTokenEnv) to a
// remote host disguised as a sidecar URL.
function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

async function checkWalletSync(manifest) {
  if (!manifest.wallet) {
    return { status: STATUS.SKIP, detail: 'no manifest.wallet section' };
  }
  const { diagnosticsUrl, diagnosticsTokenEnv } = manifest.wallet;
  if (!diagnosticsUrl) {
    return { status: STATUS.FAIL, detail: 'manifest.wallet.diagnosticsUrl missing' };
  }
  let parsedDiagUrl;
  try {
    parsedDiagUrl = assertSafeUrl(diagnosticsUrl, 'manifest.wallet.diagnosticsUrl');
  } catch (e) {
    return { status: STATUS.FAIL, detail: redactUrlsInString(e.message) };
  }
  if (!isLoopbackHost(parsedDiagUrl.hostname)) {
    return {
      status: STATUS.FAIL,
      detail: 'manifest.wallet.diagnosticsUrl must be loopback (localhost/127.0.0.1/::1)',
      extraLines: [
        'The sidecar diagnostics endpoint is local-only by design.',
        'Pointing it at a remote host would leak the token (and any env-derived',
        'value resolved via diagnosticsTokenEnv) to an untrusted server.',
      ],
    };
  }
  let token;
  if (diagnosticsTokenEnv !== undefined) {
    try {
      assertValidEnvVarName(diagnosticsTokenEnv, 'manifest.wallet.diagnosticsTokenEnv');
    } catch (e) {
      return { status: STATUS.FAIL, detail: e.message };
    }
    token = process.env[diagnosticsTokenEnv];
    if (!token) {
      return {
        status: STATUS.FAIL,
        detail: `env var ${diagnosticsTokenEnv} is empty`,
        extraLines: ['Set the sidecar token before running, do not embed it in the manifest.'],
      };
    }
  }

  const headers = { 'accept': 'application/json' };
  if (token) headers['x-midnight-sidecar-token'] = token;

  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    resp = await fetch(diagnosticsUrl, { headers, signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    // Never echo the URL — CI logs may be public and manifest URLs may be
    // sensitive infra. The user knows what URL they put in their manifest.
    return {
      status: STATUS.FAIL,
      detail: `sidecar unreachable: ${redactUrlsInString(e.message)}`,
      extraLines: ['See references/wallet-lifecycle.md'],
    };
  }
  if (!resp.ok) {
    return {
      status: STATUS.FAIL,
      detail: `sidecar HTTP ${resp.status}`,
      extraLines: [resp.status === 401 ? 'Token rejected — confirm env var matches sidecar config' : 'Check sidecar logs'],
    };
  }
  let diag;
  try { diag = await resp.json(); } catch (e) {
    return { status: STATUS.FAIL, detail: `sidecar response not JSON: ${redactUrlsInString(e.message)}` };
  }

  // Shape per backend/src/adapters/midnight/MidnightHTLCAdapter.ts:1317-1366:
  //   { restoredFromSnapshot, walletSyncStatus, operational, isSynced,
  //     addresses: {shieldedCoinPublicKey, unshieldedAddress, dustAddress},
  //     balances: {tDUST, NIGHT, shielded, unshielded},
  //     progress: {shielded, unshielded, dust} where each progress is
  //       {appliedId, highestTransactionId, isStrictlyComplete, ...} }
  if (!diag.progress) {
    return { status: STATUS.FAIL, detail: 'sidecar response missing progress field' };
  }

  const subWallets = ['shielded', 'unshielded', 'dust'];
  const failures = [];
  const detailParts = [];

  for (const sw of subWallets) {
    const p = diag.progress[sw];
    if (!p) {
      failures.push(`${sw}: missing progress`);
      continue;
    }
    const applied = p.appliedId === 'n/a' ? null : BigInt(p.appliedId);
    const highest = p.highestTransactionId === 'n/a' ? null : BigInt(p.highestTransactionId);

    if (applied === null || highest === null) {
      failures.push(`${sw}: appliedId=${p.appliedId} highest=${p.highestTransactionId} (not numeric)`);
      continue;
    }
    if (p.isStrictlyComplete !== true) {
      failures.push(`${sw}: isStrictlyComplete=${p.isStrictlyComplete} (gap=${highest - applied}, applied=${applied}, highest=${highest})`);
      continue;
    }
    if (applied < highest) {
      failures.push(`${sw}: appliedId=${applied} < highest=${highest} (gap=${highest - applied})`);
      continue;
    }
    detailParts.push(`${sw} synced ${applied}/${highest}`);
  }

  if (failures.length > 0) {
    return {
      status: STATUS.FAIL,
      detail: 'wallet sync incomplete',
      extraLines: [...failures, 'Restart-mid-sync is normal; wait until isStrictlyComplete=true on all three.', 'See references/wallet-lifecycle.md § Sync stalls'],
    };
  }

  return { status: STATUS.PASS, detail: detailParts.join('; '), diag };
}

// =====================================================================
// Check 2: Proof-server reachability + version
// =====================================================================

async function checkProofServer(manifest) {
  if (!manifest.proofServer) {
    return { status: STATUS.SKIP, detail: 'no manifest.proofServer section' };
  }
  const { url, expectedVersion } = manifest.proofServer;
  if (!url) {
    return { status: STATUS.FAIL, detail: 'manifest.proofServer.url missing' };
  }
  try {
    assertSafeUrl(url, 'manifest.proofServer.url');
  } catch (e) {
    return { status: STATUS.FAIL, detail: redactUrlsInString(e.message) };
  }
  const versionUrl = url.replace(/\/$/, '') + '/version';
  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    resp = await fetch(versionUrl, { signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    return {
      status: STATUS.FAIL,
      detail: `proof-server unreachable: ${redactUrlsInString(e.message)}`,
      extraLines: ['docker ps | grep proof-server  # confirm container is running', 'See references/version-matrix.md'],
    };
  }
  if (!resp.ok) {
    return { status: STATUS.FAIL, detail: `proof-server HTTP ${resp.status} at /version` };
  }
  // /version returns plain text in current proof-server (e.g. "7.0.2")
  const body = (await resp.text()).trim();
  // Some versions wrap in JSON quotes; strip them.
  const running = body.replace(/^"+|"+$/g, '');

  if (!expectedVersion) {
    return {
      status: STATUS.WARN,
      detail: `running ${running}; manifest has no expectedVersion`,
      extraLines: [`Lock it in: add "expectedVersion": "${running}" to manifest.proofServer`, 'See references/version-matrix.md'],
    };
  }
  if (running !== expectedVersion) {
    return {
      status: STATUS.WARN,
      detail: `running ${running}; manifest expects ${expectedVersion} (recoverable, often SDK-compatible)`,
      extraLines: ['Version drift is recoverable but should be reconciled. See references/version-matrix.md'],
    };
  }
  return { status: STATUS.PASS, detail: `running ${running}` };
}

// =====================================================================
// Check 3: Genesis hash (Midnight)
// Source: backend/src/adapters/midnight/MidnightHTLCAdapter.ts:2462-2503
// Uses Substrate JSON-RPC `chain_getBlockHash[0]` over HTTPS (converted from wss).
// =====================================================================

async function checkGenesisHash(manifest) {
  if (!manifest.midnight) {
    return { status: STATUS.SKIP, detail: 'no manifest.midnight section' };
  }
  const { rpcUrl } = manifest.midnight;
  if (!rpcUrl) {
    return { status: STATUS.FAIL, detail: 'manifest.midnight.rpcUrl missing' };
  }
  try {
    assertSafeUrl(rpcUrl, 'manifest.midnight.rpcUrl', { allowWs: true });
  } catch (e) {
    return { status: STATUS.FAIL, detail: redactUrlsInString(e.message) };
  }
  const httpUrl = rpcUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');

  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    resp = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'chain_getBlockHash', params: [0] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    return {
      status: STATUS.FAIL,
      detail: `RPC unreachable: ${redactUrlsInString(e.message)}`,
      extraLines: ['If on a cloud VM, AWS ELB may be blocking. See references/network-chooser.md § Cloud-IP'],
    };
  }
  if (!resp.ok) {
    const serverHeader = resp.headers.get('server') || '';
    const elb = serverHeader.includes('awselb') ? ' [server: awselb/2.0 — cloud-IP block likely]' : '';
    return {
      status: STATUS.FAIL,
      detail: `RPC HTTP ${resp.status}${elb}`,
      extraLines: serverHeader.includes('awselb')
        ? ['AWS ELB is blocking your VM IP. Use a Cloudflare Worker reverse-proxy. See references/network-chooser.md']
        : [`server: ${serverHeader}`],
    };
  }

  let payload;
  try { payload = await resp.json(); } catch (e) {
    return { status: STATUS.FAIL, detail: `RPC response not JSON: ${e.message}` };
  }
  if (payload.error) {
    return { status: STATUS.FAIL, detail: `RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}` };
  }
  const actual = (payload.result || '').toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(actual)) {
    return { status: STATUS.FAIL, detail: `RPC returned non-hash result: ${actual}` };
  }

  const expected = manifest.expectedGenesisHash;
  if (!expected) {
    return {
      status: STATUS.WARN,
      detail: actual,
      extraLines: [`Lock it in: add "expectedGenesisHash": "${actual}" to manifest`, 'Catches "deployed to wrong network" on the next run.'],
    };
  }
  if (expected.toLowerCase() !== actual) {
    return {
      status: STATUS.FAIL,
      detail: `MISMATCH — expected ${expected}, got ${actual}`,
      extraLines: [
        'Likely cause: .env points to a DIFFERENT Midnight network than manifest claims.',
        'Verify MIDNIGHT_NETWORK_ID + MIDNIGHT_INDEXER_URL + MIDNIGHT_RPC_URL all agree.',
        'See references/network-chooser.md § Genesis hash table',
      ],
    };
  }
  return { status: STATUS.PASS, detail: `${actual.slice(0, 18)}...` };
}

// =====================================================================
// Check 4: Midnight contract resolution via indexer
// Query shape from MidnightHTLCAdapter.ts:3780-3830 (queryIndexerContractActionMeta).
// =====================================================================

async function checkMidnightContract(manifest) {
  if (!manifest.midnight) {
    return { status: STATUS.SKIP, detail: 'no manifest.midnight section' };
  }
  if (!manifest.midnight.contractAddress) {
    return { status: STATUS.SKIP, detail: 'no manifest.midnight.contractAddress' };
  }
  const { indexerUrl, contractAddress } = manifest.midnight;
  if (!indexerUrl) {
    return { status: STATUS.FAIL, detail: 'manifest.midnight.indexerUrl missing' };
  }
  try {
    assertSafeUrl(indexerUrl, 'manifest.midnight.indexerUrl');
  } catch (e) {
    return { status: STATUS.FAIL, detail: redactUrlsInString(e.message) };
  }
  if (typeof contractAddress !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(contractAddress)) {
    return {
      status: STATUS.FAIL,
      detail: `Midnight contract address must be 0x + 64 hex chars, got ${typeof contractAddress === 'string' ? `length ${contractAddress.length}` : typeof contractAddress}`,
    };
  }
  const normalized = contractAddress.startsWith('0x') ? contractAddress.slice(2) : contractAddress;

  const query = `
    query ContractActionMeta($address: HexEncoded!) {
      contractAction(address: $address) {
        transaction {
          hash
          block { height timestamp }
        }
      }
    }
  `;

  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    resp = await fetch(indexerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { address: normalized } }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    return { status: STATUS.FAIL, detail: `indexer unreachable: ${redactUrlsInString(e.message)}` };
  }
  if (!resp.ok) {
    return { status: STATUS.FAIL, detail: `indexer HTTP ${resp.status}` };
  }

  let body;
  try { body = await resp.json(); } catch (e) {
    return { status: STATUS.FAIL, detail: `indexer response not JSON: ${redactUrlsInString(e.message)}` };
  }
  if (body.errors && body.errors.length > 0) {
    return { status: STATUS.FAIL, detail: `indexer GraphQL error: ${redactUrlsInString(String(body.errors[0].message ?? ''))}` };
  }

  const tx = body?.data?.contractAction?.transaction;
  if (!tx?.hash) {
    return {
      status: STATUS.FAIL,
      detail: `contract ${contractAddress.slice(0, 18)}... not found on indexer`,
      extraLines: [
        'Possible causes:',
        '  - Address has a typo or was deployed to a different network',
        '  - Indexer lag (rare, < 30s normally) — retry once',
        '  - Deploy never finalized (check Phase 5 of six-phase deploy)',
        'See references/wallet-lifecycle.md § Six-phase deploy',
      ],
    };
  }
  const height = tx.block?.height ?? 'unknown';
  return {
    status: STATUS.PASS,
    detail: `${contractAddress.slice(0, 18)}... exists, deployed at block ${height}`,
  };
}

// =====================================================================
// Check 5: vk byte-equality (THE HEADLINE CHECK)
// Strategy: snarkjs verifier source bakes vk constants into bytecode as PUSH32
// opcodes. We extract local vk JSON via snarkjs zkey export, then for each
// 32-byte scalar in the vk, search the deployed bytecode for the PUSH32-prefixed
// occurrence. Missing scalars = vk mismatch = FAIL.
// =====================================================================

function bigIntToHex32(scalarStr) {
  // scalarStr is a decimal string; convert to 64-char zero-padded hex.
  const bn = BigInt(scalarStr);
  if (bn < 0n) throw new Error(`negative scalar in vk: ${scalarStr}`);
  let h = bn.toString(16);
  if (h.length > 64) throw new Error(`scalar exceeds 256 bits: ${scalarStr}`);
  return h.padStart(64, '0').toLowerCase();
}

function collectVkScalars(vk) {
  // Per snarkjs Groth16 vk JSON: vk_alpha_1 (G1 [x,y,1]), vk_beta_2/gamma_2/delta_2 (G2 [[x1,x2],[y1,y2],[1,0]]),
  // IC[] (array of G1 [x,y,1]).
  // We extract ONLY the affine coordinates the Solidity verifier embeds —
  // i.e. omit the trailing "1" / "[1,0]" identity components which never appear
  // as PUSH32 constants in snarkjs-generated verifiers.
  const out = [];
  const named = {};

  if (!vk || typeof vk !== 'object') throw new Error('vk JSON missing or not object');
  if (vk.protocol !== 'groth16') throw new Error(`vk.protocol=${vk.protocol} (expected groth16)`);
  if (vk.curve !== 'bn128') throw new Error(`vk.curve=${vk.curve} (expected bn128)`);

  const a1 = vk.vk_alpha_1;
  if (!Array.isArray(a1) || a1.length < 2) throw new Error('vk.vk_alpha_1 malformed');
  named.alphax = a1[0]; named.alphay = a1[1];

  // snarkjs Groth16 JSON stores G2 elements as [[x2, x1], [y2, y1], [1, 0]] —
  // i.e. the high-coefficient-first ordering. The Solidity verifier names
  // them x1, x2, y1, y2 in the natural order. Naming below preserves the
  // Solidity convention so error messages reference SettlementVerifier.sol's
  // constant names directly. Verified against deployed contracts 2026-04-25.
  const beta2 = vk.vk_beta_2;
  if (!Array.isArray(beta2) || beta2.length < 2 || !Array.isArray(beta2[0])) throw new Error('vk.vk_beta_2 malformed');
  named.betax2 = beta2[0][0]; named.betax1 = beta2[0][1];
  named.betay2 = beta2[1][0]; named.betay1 = beta2[1][1];

  const gamma2 = vk.vk_gamma_2;
  if (!Array.isArray(gamma2) || gamma2.length < 2) throw new Error('vk.vk_gamma_2 malformed');
  named.gammax2 = gamma2[0][0]; named.gammax1 = gamma2[0][1];
  named.gammay2 = gamma2[1][0]; named.gammay1 = gamma2[1][1];

  const delta2 = vk.vk_delta_2;
  if (!Array.isArray(delta2) || delta2.length < 2) throw new Error('vk.vk_delta_2 malformed');
  named.deltax2 = delta2[0][0]; named.deltax1 = delta2[0][1];
  named.deltay2 = delta2[1][0]; named.deltay1 = delta2[1][1];

  for (const [k, v] of Object.entries(named)) out.push({ name: k, hex: bigIntToHex32(v) });

  if (!Array.isArray(vk.IC)) throw new Error('vk.IC missing or not array');
  vk.IC.forEach((pt, i) => {
    if (!Array.isArray(pt) || pt.length < 2) throw new Error(`vk.IC[${i}] malformed`);
    out.push({ name: `IC${i}x`, hex: bigIntToHex32(pt[0]) });
    out.push({ name: `IC${i}y`, hex: bigIntToHex32(pt[1]) });
  });

  return out;
}

async function exportLocalVk(zkeyPath) {
  // Spawn snarkjs CLI. Resolve from a few common locations:
  //   1. Local node_modules (cwd-relative)
  //   2. Manifest-relative node_modules (sibling of the .zkey file)
  //   3. PATH (npm i -g snarkjs)
  const manifestDir = resolve(zkeyPath, '..');
  const candidatePaths = [
    resolve(process.cwd(), 'node_modules', '.bin', 'snarkjs'),
    resolve(manifestDir, 'node_modules', '.bin', 'snarkjs'),
    'snarkjs',
  ];

  let snarkjsBin = null;
  for (const p of candidatePaths) {
    if (p === 'snarkjs') { snarkjsBin = p; break; }
    if (existsSync(p)) { snarkjsBin = p; break; }
  }
  if (!snarkjsBin) {
    throw new Error('snarkjs CLI not found. Install: npm i -g snarkjs (or run from a workspace that has it)');
  }

  const tmp = mkdtempSync(join(tmpdir(), 'deploy-verifier-'));
  const outPath = join(tmp, 'vk.json');

  // Use execFile (no shell) so manifest-controlled zkey paths cannot inject
  // shell metacharacters. Each argument is passed verbatim as argv[i].
  try {
    await execFile(
      snarkjsBin,
      ['zkey', 'export', 'verificationkey', zkeyPath, outPath],
      { timeout: 30_000, shell: false },
    );
  } catch (e) {
    // Redact any absolute paths leaking from snarkjs stderr — keeps CI logs
    // clean of local filesystem layout.
    const raw = String(e.stderr || e.message || '');
    const stderr = redactUrlsInString(redactAbsolutePathsInString(raw));
    throw new Error(`snarkjs zkey export failed: ${stderr}`);
  }
  if (!existsSync(outPath)) {
    throw new Error('snarkjs zkey export produced no output');
  }
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

async function fetchDeployedBytecode(rpcUrl, address) {
  // URL was already validated by the caller via assertSafeUrl; assert here
  // too as defence-in-depth in case someone wires this fn directly.
  assertSafeUrl(rpcUrl, 'evm.rpcUrl');
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`evm.groth16Verifier.address must be 0x + 40 hex chars`);
  }
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 1, jsonrpc: '2.0', method: 'eth_getCode', params: [address, 'latest'],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`eth_getCode HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.error) throw new Error(`eth_getCode error: ${redactUrlsInString(String(body.error.message ?? ''))}`);
  const code = (body.result || '').toLowerCase();
  if (code === '0x' || code === '') {
    throw new Error(`No bytecode at ${address} — address has no contract`);
  }
  return code;
}

async function checkVkByteEquality(manifest, manifestPath) {
  if (!manifest.evm?.groth16Verifier) {
    return { status: STATUS.SKIP, detail: 'no manifest.evm.groth16Verifier section' };
  }
  const { address, localZkeyPath } = manifest.evm.groth16Verifier;
  const rpcUrl = manifest.evm.rpcUrl;
  if (!address) return { status: STATUS.FAIL, detail: 'groth16Verifier.address missing' };
  if (!localZkeyPath) return { status: STATUS.FAIL, detail: 'groth16Verifier.localZkeyPath missing' };
  if (!rpcUrl) return { status: STATUS.FAIL, detail: 'evm.rpcUrl missing' };
  try {
    assertSafeUrl(rpcUrl, 'manifest.evm.rpcUrl');
  } catch (e) {
    return { status: STATUS.FAIL, detail: redactUrlsInString(e.message) };
  }
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { status: STATUS.FAIL, detail: 'groth16Verifier.address must be 0x + 40 hex chars' };
  }
  if (typeof localZkeyPath !== 'string' || localZkeyPath.length === 0) {
    return { status: STATUS.FAIL, detail: 'groth16Verifier.localZkeyPath must be non-empty string' };
  }
  // Reject NUL bytes and shell-special chars that can't appear in any sane
  // path. The execFile invocation is shell-free so this is belt-and-braces.
  if (localZkeyPath.includes('\0')) {
    return { status: STATUS.FAIL, detail: 'groth16Verifier.localZkeyPath contains NUL byte' };
  }

  const resolvedZkey = resolveLocalPath(localZkeyPath, manifestPath);
  if (!existsSync(resolvedZkey)) {
    return {
      status: STATUS.FAIL,
      detail: `local zkey not found: ${redactPath(resolvedZkey)}`,
      extraLines: ['Build artifacts may not be checked in; verify .gitignore allowlist.'],
    };
  }
  const stat = statSync(resolvedZkey);
  if (!stat.isFile()) {
    return { status: STATUS.FAIL, detail: `local zkey is not a regular file: ${redactPath(resolvedZkey)}` };
  }
  const sz = stat.size;
  if (sz < 1024) {
    return { status: STATUS.FAIL, detail: `local zkey suspiciously small: ${sz} bytes` };
  }

  // 1. Extract local vk. Fail closed on ANY error — uncertainty here means
  //    we cannot prove the deployed verifier matches.
  let vk;
  try { vk = await exportLocalVk(resolvedZkey); } catch (e) {
    return { status: STATUS.FAIL, detail: `vk extraction failed: ${redactUrlsInString(e.message)}` };
  }

  // 2. Collect all scalars the verifier embeds. Parse errors → FAIL.
  let scalars;
  try { scalars = collectVkScalars(vk); } catch (e) {
    return { status: STATUS.FAIL, detail: `vk parse failed: ${e.message}` };
  }
  if (!Array.isArray(scalars) || scalars.length === 0) {
    return { status: STATUS.FAIL, detail: 'vk parse produced zero scalars (cannot verify against bytecode)' };
  }

  // 3. Pull deployed bytecode. Network errors → FAIL (never SKIP — we cannot
  //    say the deploy is safe if we couldn't read the bytecode).
  let bytecode;
  try { bytecode = await fetchDeployedBytecode(rpcUrl, address); } catch (e) {
    return { status: STATUS.FAIL, detail: `eth_getCode failed: ${redactUrlsInString(e.message)}` };
  }

  // 4. For each scalar, search bytecode for PUSH(N) + scalar.
  //
  // The Solidity compiler emits a `uint256 constant = X` as a PUSH opcode of
  // exactly the byte length needed: PUSH32 (0x7f) for 256-bit values, but for
  // smaller scalars (high byte = 0x00) it emits PUSHN where N = byte length.
  // PUSH1 = 0x60, PUSH32 = 0x7f. So a 31-byte scalar is `0x7e <31 bytes>`,
  // a 30-byte scalar is `0x7d <30 bytes>`, etc.
  //
  // Implementation: strip leading 00-byte pairs from the hex; the resulting
  // byte length determines the expected PUSH opcode. Search for that prefix.
  //
  // SECURITY: short scalars are dangerous. A scalar of value 0, 1, or any
  // tiny number compresses to a 1- or 2-byte PUSH that appears all over EVM
  // bytecode by coincidence (PUSH1 0x00 = "6000" is the single most common
  // 2-byte sequence in any contract). Matching on those is a false-PASS bug
  // that defeats the entire check. We treat any scalar that compresses to
  // <= 4 bytes as REQUIRING the full PUSH32 form to match — if Solidity
  // emitted the compressed form we will not be able to find it, but a vk
  // mismatch reported as PASS is far worse than a false FAIL on a curve
  // identity element. snarkjs-emitted vk scalars are bn254 field elements
  // and are overwhelmingly full-width 32 bytes; observation across
  // SettlementVerifier deployments confirms zero IC entries of <4 bytes.
  //
  // A scalar that does not appear → deployed contract was generated from a
  // DIFFERENT zkey. This is the headline vk-mismatch FAIL.
  const code = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const MIN_TRIMMED_BYTES = 4;
  const missing = [];
  for (const { name, hex } of scalars) {
    if (hex.length !== 64) {
      // Defensive: collectVkScalars already pads to 64; if we ever see
      // anything else, fail closed rather than risk a malformed needle.
      missing.push({ name, hex, reason: `hex length=${hex.length} (expected 64)` });
      continue;
    }
    // Strip leading "00" byte pairs to get the natural byte width.
    let trimmed = hex;
    while (trimmed.length > 2 && trimmed.startsWith('00')) {
      trimmed = trimmed.slice(2);
    }
    const byteLen = trimmed.length / 2;
    // PUSH1 = 0x60, so PUSH(N) = 0x60 + N - 1 = 0x5f + N.
    const pushOpcode = (0x5f + byteLen).toString(16).padStart(2, '0');
    // Always require either:
    //   (a) the full 32-byte form `7f <hex>` to appear in bytecode, OR
    //   (b) the compressed form `<pushN> <trimmed>` — but ONLY when the
    //       trimmed scalar is wide enough that coincidental matches in
    //       bytecode are vanishingly unlikely. Below 4 bytes, refuse the
    //       compressed form to avoid false-PASS on common opcode patterns.
    const fullForm = '7f' + hex;
    const compressedForm = pushOpcode + trimmed;
    const fullMatch = code.includes(fullForm);
    const compressedMatch = byteLen >= MIN_TRIMMED_BYTES && code.includes(compressedForm);
    // Last-resort: raw 32-byte hex as substring (rare alternate codegen
    // paths, e.g. constants merged into PUSH32 of a struct word). This was
    // already in the original implementation; keep it but log if it's the
    // only thing that hit.
    const rawMatch = !fullMatch && !compressedMatch && code.includes(hex);
    if (!fullMatch && !compressedMatch && !rawMatch) {
      missing.push({ name, hex, expectedPrefix: pushOpcode, byteLen });
    }
  }

  if (missing.length > 0) {
    const sample = missing.slice(0, 3).map((m) => `  ${m.name}: 0x${m.hex.slice(0, 16)}... NOT in bytecode`);
    return {
      status: STATUS.FAIL,
      detail: `${missing.length}/${scalars.length} vk scalar(s) missing from deployed bytecode`,
      extraLines: [
        ...sample,
        ...(missing.length > 3 ? [`  ...and ${missing.length - 3} more`] : []),
        '',
        'DIAGNOSIS: Deployed verifier was generated from a DIFFERENT zkey.',
        'This is the vk-mismatch bug class. Every settlement proof submitted to',
        'this verifier will return false on-chain. Funds locked in HTLCs will be',
        'unrecoverable except via timelock refund.',
        '',
        'REMEDIATION (pick one):',
        '  A) Redeploy the verifier:',
        '       snarkjs zkey export solidityverifier <local.zkey> Verifier.sol',
        '       <deploy Verifier.sol; update manifest with new address>',
        '  B) Rebuild the local zkey from the original ceremony output (only if',
        '     the deployed verifier is canonical). Note: re-running snarkjs zkey',
        '     contribute changes the vk silently — never do this on a live zkey.',
        '',
        'See references/groth16-vk-mismatch.md for the full incident playbook.',
      ],
    };
  }

  // Count G1/G2 / IC entries for the success message.
  const icCount = scalars.filter((s) => s.name.startsWith('IC')).length / 2;
  const fixedCount = scalars.length - (icCount * 2);
  return {
    status: STATUS.PASS,
    detail: `local & deployed match (${fixedCount} G1/G2 scalars + ${icCount} IC entries)`,
  };
}

// =====================================================================
// Check 6: RPC reachability
// =====================================================================

async function checkRpcReachability(manifest) {
  const results = [];
  const failures = [];

  // EVM https RPC: eth_chainId, verify match.
  if (manifest.evm?.rpcUrl) {
    try {
      assertSafeUrl(manifest.evm.rpcUrl, 'manifest.evm.rpcUrl');
    } catch (e) {
      failures.push(redactUrlsInString(e.message));
    }
  }
  if (manifest.evm?.rpcUrl && failures.length === 0) {
    const expectedChainId = manifest.evm.chainId;
    try {
      const resp = await fetch(manifest.evm.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        failures.push(`EVM RPC HTTP ${resp.status}`);
      } else {
        const body = await resp.json();
        if (body.error) {
          failures.push(`EVM RPC error: ${redactUrlsInString(String(body.error.message ?? ''))}`);
        } else if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) {
          failures.push(`EVM RPC returned non-hex chainId: ${typeof body.result}`);
        } else {
          const actualChainId = parseInt(body.result, 16);
          if (!Number.isFinite(actualChainId)) {
            failures.push(`EVM RPC chainId parse failed: ${body.result}`);
          } else if (expectedChainId && actualChainId !== expectedChainId) {
            failures.push(`EVM chainId mismatch: manifest=${expectedChainId} actual=${actualChainId}`);
          } else {
            results.push(`EVM chainId=${actualChainId} OK`);
          }
        }
      }
    } catch (e) {
      failures.push(`EVM RPC unreachable: ${redactUrlsInString(e.message)}`);
    }
  }

  // Midnight wss RPC: open WebSocket, time out fast.
  if (manifest.midnight?.rpcUrl) {
    try {
      assertSafeUrl(manifest.midnight.rpcUrl, 'manifest.midnight.rpcUrl', { allowWs: true });
    } catch (e) {
      failures.push(redactUrlsInString(e.message));
    }
    let WSCtor;
    try {
      WSCtor = (await import('ws')).default;
    } catch {
      // ws not installed — skip but warn.
      results.push('Midnight wss probe SKIPPED (npm i ws to enable)');
    }
    if (WSCtor) {
      const wsResult = await new Promise((res) => {
        const ws = new WSCtor(manifest.midnight.rpcUrl, {
          handshakeTimeout: 5_000,
          followRedirects: true,
        });
        const t = setTimeout(() => {
          try { ws.terminate(); } catch {}
          res({ ok: false, reason: 'timeout' });
        }, 5_000);
        ws.on('open', () => {
          clearTimeout(t);
          try { ws.close(); } catch {}
          res({ ok: true });
        });
        ws.on('unexpected-response', (_req, response) => {
          clearTimeout(t);
          const elb = (response.headers?.server || '').includes('awselb');
          res({ ok: false, reason: `HTTP ${response.statusCode}${elb ? ' (awselb/2.0 — cloud-IP block)' : ''}` });
          try { ws.terminate(); } catch {}
        });
        ws.on('error', (e) => {
          clearTimeout(t);
          res({ ok: false, reason: redactUrlsInString(e.message) });
          try { ws.terminate(); } catch {}
        });
      });
      if (wsResult.ok) {
        results.push('Midnight wss OK');
      } else {
        failures.push(`Midnight wss: ${wsResult.reason}`);
      }
    }
  }

  if (results.length === 0 && failures.length === 0) {
    return { status: STATUS.SKIP, detail: 'no RPC URLs in manifest' };
  }
  if (failures.length > 0) {
    const elbHit = failures.some((f) => f.includes('awselb'));
    return {
      status: STATUS.FAIL,
      detail: failures.join('; '),
      extraLines: elbHit ? [
        'AWS ELB is blocking your VM IP. Use a Cloudflare Worker reverse-proxy.',
        'See references/network-chooser.md § Cloud-IP block',
      ] : [],
    };
  }
  return { status: STATUS.PASS, detail: results.join('; ') };
}

// =====================================================================
// Check 7: DUST balance (Midnight)
// =====================================================================

function checkDustBalance(manifest, walletDiag) {
  if (!manifest.wallet) {
    return { status: STATUS.SKIP, detail: 'no manifest.wallet section' };
  }
  if (!walletDiag) {
    return { status: STATUS.SKIP, detail: 'wallet diagnostics unavailable (Check 1 failed)' };
  }
  const tDustStr = walletDiag.balances?.tDUST ?? '0';
  let tDust;
  try { tDust = BigInt(tDustStr); } catch {
    return { status: STATUS.WARN, detail: `tDUST balance non-numeric: ${tDustStr}` };
  }
  if (tDust === 0n) {
    return {
      status: STATUS.WARN,
      detail: 'tDUST balance is 0 — backend cannot pay tx fees',
      extraLines: [
        'Either NIGHT-for-DUST registration has not run, or it has been < 12hr since registration.',
        'See references/dust-night-registration.md for the bootstrap procedure.',
      ],
    };
  }
  // Format with 6 decimal places (DUST has 6 decimals on Midnight).
  const human = (Number(tDust) / 1e6).toFixed(2);
  return { status: STATUS.PASS, detail: `${human} tDUST` };
}

// =====================================================================
// Main
// =====================================================================

async function main() {
  const args = process.argv.slice(2);
  // -h / --help is an explicit, successful invocation; exit 0.
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log('Usage: deploy-verifier.mjs <path-to-deploy-manifest.json>');
    console.log('See assets/deploy-manifest.example.json for schema.');
    process.exit(0);
  }
  // Wrong-arity invocation: print to stderr and exit non-zero.
  if (args.length !== 1) {
    console.error('Usage: deploy-verifier.mjs <path-to-deploy-manifest.json>');
    console.error('See assets/deploy-manifest.example.json for schema.');
    process.exit(2);
  }
  const manifestPath = resolve(args[0]);
  let manifest;
  try { manifest = loadManifest(manifestPath); } catch (e) {
    // Errors from loadManifest are user-facing; never leak stack traces.
    console.error(`Manifest error: ${e.message}`);
    process.exit(2);
  }

  console.log(`${COLOR.bold}Midnight Deploy Verifier${COLOR.reset} — manifest: ${redactPath(manifestPath)} (network=${manifest.network})`);
  console.log('='.repeat(74));
  console.log('');

  const checks = [
    { name: 'Wallet sync-completion', fn: () => checkWalletSync(manifest) },
    { name: 'Proof-server version  ', fn: () => checkProofServer(manifest) },
    { name: 'Genesis hash          ', fn: () => checkGenesisHash(manifest) },
    { name: 'Midnight contract     ', fn: () => checkMidnightContract(manifest) },
    { name: 'vk byte-equality      ', fn: () => checkVkByteEquality(manifest, manifestPath) },
    { name: 'RPC reachability      ', fn: () => checkRpcReachability(manifest) },
    { name: 'DUST balance          ', fn: null /* runs after Check 1 */ },
  ];

  const total = checks.length;
  const results = [];
  let walletDiag = null;

  for (let i = 0; i < total; i++) {
    const check = checks[i];
    let result;
    try {
      if (check.name.startsWith('DUST')) {
        result = checkDustBalance(manifest, walletDiag);
      } else {
        result = await check.fn();
        if (check.name.startsWith('Wallet sync')) walletDiag = result.diag;
      }
    } catch (e) {
      result = { status: STATUS.FAIL, detail: `unhandled error: ${e.message}` };
    }
    printCheck(i + 1, total, check.name, result.status, result.detail, result.extraLines || []);
    results.push({ name: check.name.trim(), ...result });
  }

  console.log('');
  const failCount = results.filter((r) => r.status === STATUS.FAIL).length;
  const warnCount = results.filter((r) => r.status === STATUS.WARN).length;
  const skipCount = results.filter((r) => r.status === STATUS.SKIP).length;
  const passCount = results.filter((r) => r.status === STATUS.PASS).length;

  if (failCount === 0) {
    const verdict = warnCount > 0
      ? `${COLOR.PASS}VERDICT${COLOR.reset}: ${passCount}/${total} passed, ${warnCount} warn, ${skipCount} skipped. Deploy is ${COLOR.bold}safe${COLOR.reset}.`
      : `${COLOR.PASS}VERDICT${COLOR.reset}: ${passCount}/${total} passed${skipCount > 0 ? ` (${skipCount} skipped)` : ''}. Deploy is ${COLOR.bold}safe${COLOR.reset}.`;
    console.log(verdict);
  } else {
    const failedNames = results.filter((r) => r.status === STATUS.FAIL).map((r) => r.name).join(', ');
    console.log(`${COLOR.FAIL}VERDICT${COLOR.reset}: ${failCount}/${total} ${COLOR.bold}failed${COLOR.reset} (${failedNames}). Deploy is ${COLOR.bold}UNSAFE${COLOR.reset}. Exit ${failCount}.`);
  }

  process.exit(failCount);
}

main().catch((e) => {
  // Never echo stack traces or absolute filesystem paths to a user-visible
  // channel — CI logs may end up in PR comments or public artifacts. Send
  // a redacted one-liner to stderr only.
  const raw = String(e && e.message ? e.message : e);
  const msg = redactUrlsInString(redactAbsolutePathsInString(raw));
  console.error(`Fatal: ${msg}`);
  process.exit(99);
});
