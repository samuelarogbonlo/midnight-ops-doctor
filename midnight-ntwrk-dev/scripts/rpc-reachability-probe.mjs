#!/usr/bin/env node
// After saving, run: chmod +x rpc-reachability-probe.mjs
//
// rpc-reachability-probe.mjs
// --------------------------
// Probe a Midnight RPC endpoint and diagnose AWS-ELB cloud-IP blocks.
//
// Background:
//   Midnight RPC blocks cloud-provider IPs (HTTP 403). The edge is AWS ELB
//   (`server: awselb/2.0`), NOT Cloudflare. Indexer endpoint is unblocked;
//   only RPC is affected. Workaround: deploy a Cloudflare Worker reverse-proxy
//   from assets/cloudflare-worker-template/.
//
// This script:
//   - Accepts wss:// or https:// URLs.
//   - Issues an HTTPS HEAD (falling back to GET) and reads status + `server` header.
//   - For wss:// it tries the `ws` package first; if missing, falls back to a
//     TCP-level reachability probe via `net.connect()`.
//   - Emits a single JSON verdict on stdout with `reachable`, `statusCode`,
//     `edgeServer`, `diagnosis`, and `recommendation`.
//
// Stdlib-first: zero hard dependencies. The `ws` package is opportunistic.

import process, { argv, stderr, stdout } from 'node:process';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
// NOTE: `exitCode` is a writable property on the `process` object; the named
// ESM export from `node:process` is read-only. Assign to `process.exitCode`
// (NOT a destructured binding) and avoid `process.exit()` so the event loop drains.

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------
export const HTTP_TIMEOUT_MS = 8_000;
export const TCP_TIMEOUT_MS = 6_000;
export const WS_HANDSHAKE_TIMEOUT_MS = 8_000;
export const HTTPS_DEFAULT_PORT = 443;
export const AWS_ELB_SERVER_HEADER = 'awselb/2.0';
export const STATUS_OK = 200;
export const STATUS_SWITCHING_PROTOCOLS = 101;
export const STATUS_FORBIDDEN = 403;

// Exit codes
export const EXIT_OK = 0;
export const EXIT_UNREACHABLE = 1;
export const EXIT_BAD_INPUT = 2;

const USAGE = `\
Usage:
  node rpc-reachability-probe.mjs <rpc-url>
  node rpc-reachability-probe.mjs --help

Examples:
  node rpc-reachability-probe.mjs https://rpc.preprod.midnight.network
  node rpc-reachability-probe.mjs wss://rpc.preview.midnight.network

Output:
  Single JSON verdict on stdout. Exit code 0 = reachable, 1 = unreachable,
  2 = bad CLI input.
`;

function printUsage(stream = stdout) {
  stream.write(USAGE);
}

function parseArgs(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { help: args.length > 0 };
  }
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    throw new Error(`Expected exactly 1 URL argument; got ${positional.length}`);
  }
  let url;
  try {
    url = new URL(positional[0]);
  } catch (err) {
    throw new Error(`Invalid URL: ${positional[0]} (${err.message})`);
  }
  if (!['https:', 'wss:'].includes(url.protocol)) {
    throw new Error(`URL scheme must be https:// or wss://; got ${url.protocol}`);
  }
  return { url };
}

function diagnose({ statusCode, edgeServer, scheme, networkErrorCode }) {
  if (networkErrorCode === 'ENOTFOUND' || networkErrorCode === 'EAI_AGAIN') {
    return {
      diagnosis: 'DNS resolution failed for the host.',
      recommendation: 'Verify the URL is correct and that DNS is functioning. ' +
        'Try `dig <host>` or `nslookup <host>`.',
    };
  }
  if (networkErrorCode === 'ECONNREFUSED') {
    return {
      diagnosis: 'Connection refused -- nothing is listening on the target port.',
      recommendation: 'Confirm the URL/port. RPC may be down, or your network may ' +
        'block outbound on that port.',
    };
  }
  if (networkErrorCode === 'ETIMEDOUT' || networkErrorCode === 'TIMEOUT') {
    return {
      diagnosis: 'Connection timed out.',
      recommendation: 'Likely a firewall/route issue between this machine and the RPC. ' +
        'If running on a cloud VM, see the cloud-IP-block recommendation in ' +
        'references/network-chooser.md.',
    };
  }
  if (
    networkErrorCode === 'CERT_HAS_EXPIRED' ||
    networkErrorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    networkErrorCode === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return {
      diagnosis: `TLS certificate problem (${networkErrorCode}).`,
      recommendation: 'Check the system trust store, ensure SNI is set correctly, ' +
        'and verify the URL host matches the cert.',
    };
  }
  if (statusCode === STATUS_OK || statusCode === STATUS_SWITCHING_PROTOCOLS) {
    return { diagnosis: 'OK', recommendation: 'Endpoint is reachable.' };
  }
  if (statusCode === STATUS_FORBIDDEN && (edgeServer || '').toLowerCase().startsWith('awselb/')) {
    return {
      diagnosis:
        'AWS ELB blocking cloud-provider IPs (HTTP 403, `server: awselb/2.0`). ' +
        'See references/network-chooser.md § Cloud-IP block. ' +
        'Indexer endpoint is unblocked; only RPC is affected.',
      recommendation:
        'Deploy a Cloudflare Worker reverse-proxy from assets/cloudflare-worker-template/ ' +
        '(`wrangler deploy`) and point your client at that hostname. ' +
        'The Worker pass-throughs WSS+HTTPS with SNI preserved.',
    };
  }
  if (statusCode === STATUS_FORBIDDEN) {
    return {
      diagnosis: `403 Forbidden (server='${edgeServer ?? 'unknown'}'). ` +
        'Not the known AWS-ELB cloud-IP block; surfacing verbatim.',
      recommendation: 'Inspect upstream ACLs / WAF rules for this endpoint.',
    };
  }
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) {
    return {
      diagnosis: `${statusCode} upstream error (server='${edgeServer ?? 'unknown'}').`,
      recommendation: 'RPC is reachable but the backend is unhealthy. Try again later, ' +
        'or check the network status page.',
    };
  }
  return {
    diagnosis: `Unhandled status ${statusCode ?? 'n/a'} (scheme=${scheme}, ` +
      `server='${edgeServer ?? 'unknown'}').`,
    recommendation: 'Inspect the verdict JSON and consult references/network-chooser.md.',
  };
}

async function probeHttps(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    } catch {
      // Some endpoints reject HEAD with a network error; retry GET.
      res = await fetch(url, { method: 'GET', signal: controller.signal });
    }
    return {
      statusCode: res.status,
      edgeServer: res.headers.get('server') ?? null,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('HTTPS probe timed out');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    // Surface low-level cause code where available (errno-style).
    const code = err.cause?.code ?? err.code ?? null;
    const e = new Error(`HTTPS probe failed: ${err.message}`);
    e.code = code;
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function probeWssWithWs(url) {
  // Opportunistic dynamic import of `ws`. If unavailable, caller falls back
  // to a TCP probe so the user always gets *some* signal.
  let WS;
  try {
    ({ default: WS } = await import('ws'));
  } catch (err) {
    const e = new Error('`ws` package not installed -- using TCP fallback');
    e.code = 'WS_MISSING';
    e.cause = err;
    throw e;
  }
  return new Promise((resolve, reject) => {
    const socket = new WS(url.toString(), {
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
    });
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      try { socket.terminate(); } catch { /* ignore */ }
      fn(val);
    };
    socket.once('upgrade', (msg) => {
      settle(resolve, {
        statusCode: msg.statusCode ?? STATUS_SWITCHING_PROTOCOLS,
        edgeServer: msg.headers?.server ?? null,
      });
    });
    socket.once('unexpected-response', (_req, res) => {
      settle(resolve, {
        statusCode: res.statusCode,
        edgeServer: res.headers?.server ?? null,
      });
    });
    socket.once('error', (err) => {
      const e = new Error(`WSS probe failed: ${err.message}`);
      e.code = err.code ?? null;
      e.cause = err;
      settle(reject, e);
    });
  });
}

async function probeTcp(url) {
  const port = url.port ? Number(url.port) : HTTPS_DEFAULT_PORT;
  const host = url.hostname;
  return new Promise((resolve, reject) => {
    // Use TLS for 443 (so we exercise the same path as RPC), TCP otherwise.
    const isTls = port === HTTPS_DEFAULT_PORT;
    const socket = isTls
      ? tlsConnect({ host, port, servername: host, timeout: TCP_TIMEOUT_MS })
      : tcpConnect({ host, port, timeout: TCP_TIMEOUT_MS });
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      fn(val);
    };
    const onConnect = () => settle(resolve, { statusCode: null, edgeServer: null, tcpOk: true });
    socket.once(isTls ? 'secureConnect' : 'connect', onConnect);
    socket.once('timeout', () => {
      const e = new Error('TCP probe timed out');
      e.code = 'ETIMEDOUT';
      settle(reject, e);
    });
    socket.once('error', (err) => {
      const e = new Error(`TCP probe failed: ${err.message}`);
      e.code = err.code ?? null;
      e.cause = err;
      settle(reject, e);
    });
  });
}

async function probe(url) {
  if (url.protocol === 'https:') {
    return await probeHttps(url);
  }
  // wss://
  try {
    return await probeWssWithWs(url);
  } catch (err) {
    if (err.code !== 'WS_MISSING') throw err;
    stderr.write(
      'NOTE: `ws` package not installed; falling back to TCP-level reachability probe. ' +
      'For a full WSS handshake verdict run: npm i ws\n',
    );
    const tcp = await probeTcp(url);
    return { ...tcp, statusCode: tcp.tcpOk ? STATUS_SWITCHING_PROTOCOLS : null };
  }
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

  const { url } = parsed;
  let result, networkErrorCode = null;
  try {
    result = await probe(url);
  } catch (err) {
    networkErrorCode = err.code ?? null;
    result = { statusCode: null, edgeServer: null };
  }

  const { diagnosis, recommendation } = diagnose({
    statusCode: result.statusCode,
    edgeServer: result.edgeServer,
    scheme: url.protocol.replace(':', ''),
    networkErrorCode,
  });

  const reachable =
    !networkErrorCode &&
    (result.statusCode === STATUS_OK || result.statusCode === STATUS_SWITCHING_PROTOCOLS);

  const verdict = {
    url: url.toString(),
    reachable,
    statusCode: result.statusCode,
    edgeServer: result.edgeServer,
    networkErrorCode,
    diagnosis,
    recommendation,
  };
  stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exitCode = reachable ? EXIT_OK : EXIT_UNREACHABLE;
}

await main();
