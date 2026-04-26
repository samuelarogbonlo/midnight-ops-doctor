/**
 * Midnight RPC Proxy — Cloudflare Worker
 *
 * Reverse-proxies wss://rpc.preprod.midnight.network (and HTTPS fallback) to
 * bypass AWS ELB's ASN-scoped IP-reputation block against cloud egress.
 *
 * Design constraints:
 *   - Preserve SNI/Host = rpc.preprod.midnight.network (wildcard cert binding).
 *   - Stream bodies in both directions (signed tx payloads can be ~1 MB).
 *   - Long-lived WebSocket subscriptions (author_submitAndWatchExtrinsic can
 *     stream ready -> broadcast -> inBlock -> finalized over 10-30s).
 *   - No CORS headers: clients are server-side (@midnight-ntwrk wallet-sdk).
 *   - No body logging: request bodies contain signed transaction data.
 */

const UPSTREAM_HOST = 'rpc.preprod.midnight.network';
const UPSTREAM_ORIGIN_HTTPS = `https://${UPSTREAM_HOST}`;
const UPSTREAM_ORIGIN_WS_HANDSHAKE = `https://${UPSTREAM_HOST}`;

// Headers that must not be forwarded to the upstream; CF sets/strips these.
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // CF-specific headers we do not want to leak upstream.
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cf-ew-via',
  'x-forwarded-proto',
  'x-real-ip',
  // Host is reset by the runtime when we fetch against a different origin.
  'host',
]);

type CanaryStatus = 'healthy' | 'blocked' | 'unknown';

interface CanaryResult {
  status: CanaryStatus;
  upstreamStatus: number;
  server: string | null;
  checkedAt: string;
}

export interface Env {
  // No bindings required today; placeholder for future secrets (e.g. upstream
  // auth, alerting webhooks) without breaking the type signature.
  readonly _unused?: never;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Diagnostic endpoint — must not collide with any Substrate RPC path.
    if (url.pathname === '/__canary') {
      return handleCanary();
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      return handleWebSocket(request, url, ctx);
    }

    return handleHttp(request, url);
  },
} satisfies ExportedHandler<Env>;

/* ------------------------------------------------------------------ */
/* HTTP pass-through                                                   */
/* ------------------------------------------------------------------ */

async function handleHttp(request: Request, url: URL): Promise<Response> {
  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN_HTTPS);
  const upstreamRequest = buildUpstreamRequest(request, upstreamUrl);

  try {
    const upstreamResponse = await fetch(upstreamRequest);
    // Return the response as-is: streams the body, preserves headers/status.
    // We explicitly construct a new Response so we can strip any hop-by-hop
    // headers the runtime might surface, without buffering the body.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: filterResponseHeaders(upstreamResponse.headers),
    });
  } catch (err) {
    return jsonError(502, 'upstream_unreachable', errorMessage(err));
  }
}

function buildUpstreamRequest(request: Request, upstreamUrl: URL): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // Forward the body as a stream; do NOT read it into memory. This matters
  // for ~1 MB signed-transaction payloads.
  const init: RequestInit = {
    method: request.method,
    headers,
    body: methodAllowsBody(request.method) ? request.body : null,
    redirect: 'manual',
  };

  return new Request(upstreamUrl.toString(), init);
}

function methodAllowsBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WebSocket pass-through                                              */
/* ------------------------------------------------------------------ */

async function handleWebSocket(
  request: Request,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  // Open WS to upstream via fetch(). In Cloudflare Workers, outbound WS
  // upgrades are initiated by fetching the HTTPS origin with
  // Upgrade: websocket; do not fetch a wss:// URL directly.
  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN_WS_HANDSHAKE);

  const upstreamHeaders = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // Must preserve Sec-WebSocket-Protocol if present (subprotocol negotiation).
    upstreamHeaders.set(name, value);
  }
  upstreamHeaders.set('Upgrade', 'websocket');

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: upstreamHeaders,
    });
  } catch (err) {
    return jsonError(502, 'upstream_ws_unreachable', errorMessage(err));
  }

  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    // Upstream refused the upgrade; propagate the HTTP response verbatim so
    // the client sees the real status (e.g. 403 if our egress got blocked).
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: filterResponseHeaders(upstreamResponse.headers),
    });
  }

  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  // Must call accept() on both ends before any send/close.
  serverSocket.accept();
  upstreamSocket.accept();

  // Keep the Worker alive for the duration of the session. Resolved when
  // either side closes cleanly or errors.
  ctx.waitUntil(pipeWebSockets(serverSocket, upstreamSocket));

  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}

function pipeWebSockets(
  clientSide: WebSocket,
  upstreamSide: WebSocket,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Client -> upstream
    clientSide.addEventListener('message', (event) => {
      try {
        upstreamSide.send(event.data);
      } catch {
        // Upstream likely already closed — tear down client side.
        safeClose(clientSide, 1011, 'upstream_send_failed');
        finish();
      }
    });
    clientSide.addEventListener('close', (event) => {
      safeClose(upstreamSide, event.code, event.reason);
      finish();
    });
    clientSide.addEventListener('error', () => {
      safeClose(upstreamSide, 1011, 'client_error');
      finish();
    });

    // Upstream -> client
    upstreamSide.addEventListener('message', (event) => {
      try {
        clientSide.send(event.data);
      } catch {
        safeClose(upstreamSide, 1011, 'client_send_failed');
        finish();
      }
    });
    upstreamSide.addEventListener('close', (event) => {
      safeClose(clientSide, event.code, event.reason);
      finish();
    });
    upstreamSide.addEventListener('error', () => {
      safeClose(clientSide, 1011, 'upstream_error');
      finish();
    });
  });
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    // Codes 1005/1006 are reserved and must not be set by endpoints; fall
    // back to 1000 (normal) in that case.
    const safeCode = code === 1005 || code === 1006 ? 1000 : code;
    socket.close(safeCode, reason);
  } catch {
    // Socket already closed — ignore.
  }
}

/* ------------------------------------------------------------------ */
/* Canary                                                              */
/* ------------------------------------------------------------------ */

async function handleCanary(): Promise<Response> {
  let upstreamStatus = 0;
  let server: string | null = null;
  try {
    const probe = await fetch(UPSTREAM_ORIGIN_HTTPS + '/', {
      method: 'GET',
      // Keep headers minimal — we only care about reachability / ELB verdict.
      headers: { 'user-agent': 'midnight-rpc-proxy-canary/1' },
    });
    upstreamStatus = probe.status;
    server = probe.headers.get('server');
    // Drain to avoid leaking the connection.
    await probe.arrayBuffer().catch(() => undefined);
  } catch (err) {
    const result: CanaryResult = {
      status: 'unknown',
      upstreamStatus: 0,
      server: null,
      checkedAt: new Date().toISOString(),
    };
    return json(503, { ...result, error: errorMessage(err) });
  }

  const status: CanaryStatus =
    upstreamStatus === 405
      ? 'healthy'
      : upstreamStatus === 403
        ? 'blocked'
        : 'unknown';

  const result: CanaryResult = {
    status,
    upstreamStatus,
    server,
    checkedAt: new Date().toISOString(),
  };
  return json(200, result);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function jsonError(status: number, error: string, detail: string): Response {
  return json(status, { error, detail });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown_error';
}
