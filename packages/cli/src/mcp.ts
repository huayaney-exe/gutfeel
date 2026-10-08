// Talking to an MCP server: initialize, list tools, call tools. Streamable HTTP (with OAuth or a bearer token)
// and stdio. Responses may arrive as plain JSON or as an SSE stream; both are handled.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type Target =
  | { kind: 'http'; url: string; headers?: Record<string, string> }
  | { kind: 'stdio'; command: string[]; env?: Record<string, string> };

export type Surface = {
  $contract: 'surface@1';
  server: { name: string; version: string; transport: string; instructions: string };
  tools: { name: string; description: string; inputSchema?: unknown; annotations?: Record<string, unknown> }[];
  hash: string; captured_at: string;
};

const parseRpc = (raw: string) => {
  const t = raw.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  return JSON.parse(data[data.length - 1]);
};

// ── HTTP ──
export class HttpClient {
  private session: string | null = null;
  private id = 0;
  constructor(private url: string, private headers: Record<string, string> = {}) {}
  async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers, ...(this.session ? { 'mcp-session-id': this.session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
    if (r.status === 401) throw new AuthRequired(r.headers.get('www-authenticate') ?? '');
    if (notify) return null;
    const raw = await r.text();
    if (!r.ok) throw new Error(`${method} → HTTP ${r.status}: ${raw.slice(0, 300)}`);
    const j = parseRpc(raw);
    if (j.error) throw new Error(`${method} → ${JSON.stringify(j.error)}`);
    return j.result;
  }
}
export class AuthRequired extends Error { constructor(public challenge: string) { super('the server requires authorization'); } }

// ── stdio ──
export class StdioClient {
  private proc; private id = 0; private buf = ''; private waiting = new Map<number, (v: any) => void>();
  constructor(command: string[], env: Record<string, string> = {}) {
    // Only the variables named for the server reach it: a test run never leaks the operator's whole environment.
    this.proc = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
    (async () => {
      const reader = this.proc.stdout.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        this.buf += dec.decode(value);
        let i; while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          try { const m = JSON.parse(line); if (m.id != null && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id); } } catch { /* server log line */ }
        }
      }
    })();
  }
  rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const msg = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n'); this.proc.stdin.flush();
    if (notify) return Promise.resolve(null);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), 30_000);
      this.waiting.set(this.id, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method} → ${JSON.stringify(m.error)}`)) : res(m.result); });
    });
  }
  close() { this.proc.kill(); }
}

export async function snapshot(target: Target): Promise<Surface> {
  const client = target.kind === 'http' ? new HttpClient(target.url, target.headers) : new StdioClient(target.command, target.env);
  try {
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gutfeel', version: '0.1.0' } });
    await client.rpc('notifications/initialized', undefined, true);
    const tools: Surface['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.rpc('tools/list', cursor ? { cursor } : {});
      for (const t of page.tools ?? []) tools.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema, annotations: t.annotations });
      cursor = page.nextCursor;
    } while (cursor);
    const body = {
      server: { name: init.serverInfo?.name ?? 'server', version: init.serverInfo?.version ?? '', transport: target.kind === 'http' ? 'streamable-http' : 'stdio', instructions: init.instructions ?? '' },
      tools,
    };
    return { $contract: 'surface@1', ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), captured_at: new Date().toISOString() };
  } finally { if (client instanceof StdioClient) client.close(); }
}

// ── OAuth 2.1: discovery, dynamic client registration, PKCE, a loopback redirect, refresh ──
export type Tokens = { access_token: string; refresh_token?: string; expires_at?: number; client_id: string; token_endpoint: string };

async function discover(url: string) {
  const origin = new URL(url).origin;
  let as = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  if (!as.ok) {
    const pr = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    if (!pr.ok) throw new Error('no OAuth metadata found on the server');
    const issuer = (await pr.json()).authorization_servers?.[0];
    as = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  }
  return as.json() as Promise<any>;
}

export async function authorize(url: string, tokenFile: string): Promise<Tokens> {
  const meta = await discover(url);
  const port = 8976 + Math.floor(Math.random() * 200);
  const redirect = `http://127.0.0.1:${port}/callback`;
  const reg: any = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'gutfeel', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  if (!reg.client_id) throw new Error(`client registration failed: ${JSON.stringify(reg)}`);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const scope = (meta.scopes_supported ?? []).join(' ');
  const auth = `${meta.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`;
  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== '/callback') return new Response('', { status: 404 });
      const c = u.searchParams.get('code');
      setTimeout(() => server.stop(), 200);
      if (!c || u.searchParams.get('state') !== state) { reject(new Error(u.searchParams.get('error') ?? 'authorization failed')); return new Response('Authorization failed. You can close this tab.'); }
      resolve(c); return new Response('gutfeel is connected. You can close this tab.');
    } });
    console.log(`\nOpening your browser to authorize gutfeel on ${new URL(url).host}…\nIf it doesn't open: ${auth}\n`);
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', auth]);
  });
  const tok: any = await (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) })).json();
  if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  const tokens: Tokens = { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined, client_id: reg.client_id, token_endpoint: meta.token_endpoint };
  writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
  return tokens;
}

// Returns a valid access token, refreshing it when it's about to expire.
export async function accessToken(tokenFile: string): Promise<string | null> {
  if (!existsSync(tokenFile)) return null;
  const t: Tokens = JSON.parse(readFileSync(tokenFile, 'utf8'));
  if (!t.expires_at || t.expires_at - Date.now() > 120_000 || !t.refresh_token) return t.access_token;
  const r: any = await (await fetch(t.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }) })).json();
  if (!r.access_token) return null;
  const next: Tokens = { ...t, access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined };
  writeFileSync(tokenFile, JSON.stringify(next), { mode: 0o600 });
  return next.access_token;
}
