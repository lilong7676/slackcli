/**
 * `slackcli listen`: Slack's own web-client event socket, as JSON lines.
 *
 * The browser login (xoxc token + `d` cookie) can open the same WebSocket the web
 * client uses, so new messages arrive within a second instead of on the next poll.
 * This is the web client's internal socket, not a documented API: it can change
 * without notice. Port of `slk listen` (github.com/luoxiu/slk, MIT):
 *
 * - dial wss-primary.slack.com with the token and team in the query and the
 *   cookie on the upgrade request; wait for `hello`;
 * - Slack pings about every 30s; a socket that delivers nothing for 60s, or no
 *   hello within 90s, is closed and dialled again;
 * - reconnect with backoff 1s → 30s, reset only after a connection stayed up a
 *   minute; a refused login ends the run (exit 2) instead of retrying forever;
 * - a machine waking from sleep drops the socket and dials again;
 * - every attempt ends in exactly one `disconnected` line, so a caller knows to
 *   catch up on what it may have missed.
 *
 * Nothing printed ever carries a credential: the socket URL holds the token, so
 * every error text goes through redact().
 */

import type { BrowserAuthConfig } from '../types/index.ts';
import { SLACK_COOKIE_PATTERN, SLACK_TOKEN_PATTERN } from './log-redaction.ts';

export const SOCKET_BASE_URL = 'wss://wss-primary.slack.com';

/** Same User-Agent the browser transport sends on HTTP calls (slack-client.ts). */
const USER_AGENT = 'Mozilla/5.0 (compatible; SlackCLI/0.1.0)';

/**
 * The Slack web build the socket claims to be (a build timestamp; slk's value, observed
 * 2026-07-30). The gateway checks it: empty and it accepts the upgrade but never says hello;
 * unknown and it answers `{"type":"error","error":{"msg":"force_reload"}}`. When Slack retires
 * this build, pass a newer one with --agent-version or SLACKCLI_AGENT_VERSION.
 */
export const DEFAULT_AGENT_VERSION = '1785403654';

/** The web client's start arguments, key for key (slk, from captured sessions). */
function startArgs(agentVersion: string): string {
  return (
    `?agent=client&org_wide_aware=true&agent_version=${encodeURIComponent(agentVersion)}&eac_cache_ts=true&cache_ts=0` +
    '&name_tagging=true&only_self_subteams=true&connect_only=true&ms_latest=true'
  );
}

export function buildSocketUrl(
  config: Pick<BrowserAuthConfig, 'xoxc_token' | 'workspace_id'>,
  base: string = SOCKET_BASE_URL,
  agentVersion: string = DEFAULT_AGENT_VERSION,
): string {
  const query = new URLSearchParams({
    token: config.xoxc_token,
    sync_desync: '1',
    slack_client: 'desktop',
    start_args: startArgs(agentVersion),
    no_query_on_subscribe: '1',
    flannel: '3',
    lazy_channels: '1',
    gateway_server: `${config.workspace_id}-1`,
    batch_presence_aware: '1',
  });
  return `${base}/?${query.toString()}`;
}

export function socketHeaders(config: Pick<BrowserAuthConfig, 'xoxd_token'>): Record<string, string> {
  return {
    Cookie: `d=${encodeURIComponent(config.xoxd_token)}`,
    Origin: 'https://app.slack.com',
    'User-Agent': USER_AGENT,
  };
}

const QUERY_PATTERN = /\?[^\s"']+/g;

/** Strip tokens, the session cookie and any URL query (which holds the token) from a text. */
export function redact(text: string): string {
  // Same patterns as the log redaction; plain-string replacements so this works on any text.
  return text
    .replace(QUERY_PATTERN, '?[REDACTED]')
    .replace(SLACK_TOKEN_PATTERN.pattern, 'xox?-[REDACTED]')
    .replace(SLACK_COOKIE_PATTERN.pattern, 'd=[REDACTED]');
}

// ---- output lines --------------------------------------------------------------------------------

export type ListenLine =
  | { type: 'hello'; at: string; team_id: string; user_id: string }
  | {
      type: 'message';
      at: string;
      channel_id: string;
      ts: string;
      thread_ts?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      text: string;
      changed: boolean;
      mentions_me: boolean;
      is_dm: boolean;
    }
  | { type: 'message_deleted'; at: string; channel_id: string; ts: string }
  | { type: 'reaction_added' | 'reaction_removed'; at: string; channel_id: string; ts: string; user_id: string; emoji: string }
  | { type: 'channel_marked'; at: string; channel_id: string; ts: string }
  | { type: 'thread_marked'; at: string; channel_id: string; thread_ts: string; ts: string }
  | { type: 'disconnected'; at: string; error: string };

/** Message subtypes that are someone saying something; system notices (joins, topic changes…) are left out. */
const SPOKEN_SUBTYPES = new Set(['', 'bot_message', 'thread_broadcast', 'file_share', 'me_message']);
const MARKED_TYPES = new Set(['channel_marked', 'im_marked', 'group_marked', 'mpim_marked']);

type Frame = Record<string, any>;

function messageLine(m: Frame, channel: string, changed: boolean, userId: string, at: string): ListenLine | null {
  if (typeof m.ts !== 'string' || !channel) return null;
  const text = typeof m.text === 'string' ? m.text : '';
  const line: ListenLine = {
    type: 'message',
    at,
    channel_id: channel,
    ts: m.ts,
    text,
    changed,
    mentions_me: userId !== '' && text.includes(`<@${userId}>`),
    is_dm: channel.startsWith('D'),
  };
  if (typeof m.thread_ts === 'string') line.thread_ts = m.thread_ts;
  if (typeof m.user === 'string') line.user = m.user;
  if (typeof m.bot_id === 'string') line.bot_id = m.bot_id;
  if (typeof m.subtype === 'string' && m.subtype) line.subtype = m.subtype;
  return line;
}

/**
 * One socket frame → at most one output line. Frames the caller has no use for
 * (presence, typing, pongs, user/channel updates, malformed JSON) give null.
 * `hello` is handled by the connection loop, not here.
 */
export function parseFrame(raw: string, userId: string, at: string): ListenLine | null {
  let f: Frame;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object' || typeof f.type !== 'string') return null;

  if (f.type === 'message') {
    const channel = typeof f.channel === 'string' ? f.channel : '';
    const subtype = typeof f.subtype === 'string' ? f.subtype : '';
    if (subtype === 'message_changed' && f.message && typeof f.message === 'object') {
      return messageLine(f.message, channel, true, userId, at);
    }
    if (subtype === 'message_deleted') {
      const ts = typeof f.deleted_ts === 'string' ? f.deleted_ts : '';
      return channel && ts ? { type: 'message_deleted', at, channel_id: channel, ts } : null;
    }
    return SPOKEN_SUBTYPES.has(subtype) ? messageLine(f, channel, false, userId, at) : null;
  }

  if (f.type === 'reaction_added' || f.type === 'reaction_removed') {
    const item = f.item ?? {};
    if (typeof item.channel !== 'string' || typeof item.ts !== 'string') return null;
    return { type: f.type, at, channel_id: item.channel, ts: item.ts, user_id: String(f.user ?? ''), emoji: String(f.reaction ?? '') };
  }

  if (MARKED_TYPES.has(f.type)) {
    return typeof f.channel === 'string' && typeof f.ts === 'string'
      ? { type: 'channel_marked', at, channel_id: f.channel, ts: f.ts }
      : null;
  }

  if (f.type === 'thread_marked') {
    const s = f.subscription ?? {};
    if (typeof s.channel !== 'string' || typeof s.thread_ts !== 'string') return null;
    return { type: 'thread_marked', at, channel_id: s.channel, thread_ts: s.thread_ts, ts: String(s.last_read ?? '') };
  }

  return null;
}

// ---- the connection loop -------------------------------------------------------------------------

/** The part of a WebSocket the loop uses; tests stand in a scripted one. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ListenTimings {
  backoffMin: number;
  backoffMax: number;
  /** How long a connection must stay up for the next retry to start from backoffMin again. */
  stableAfter: number;
  /** No frame at all (pings included) for this long: the socket is dead. */
  idleTimeout: number;
  /** No hello this long after dialling: close and dial again. */
  helloTimeout: number;
  /** How often to send an application-level ping (keeps the idle timer honest). */
  pingEvery: number;
  /** Wake-from-sleep detector: tick interval and how late a tick must be to count as a wake. */
  wakeCheck: number;
  wakeThreshold: number;
}

export const DEFAULT_TIMINGS: ListenTimings = {
  backoffMin: 1_000,
  backoffMax: 30_000,
  stableAfter: 60_000,
  idleTimeout: 60_000,
  helloTimeout: 90_000,
  pingEvery: 30_000,
  wakeCheck: 10_000,
  wakeThreshold: 5_000,
};

export type AuthCheck = 'ok' | 'refused' | 'unreachable';

export interface ListenDeps {
  connect: (url: string, headers: Record<string, string>) => SocketLike;
  /** auth.test, run when an attempt never got a hello: a refused login stops the run. */
  checkAuth: () => Promise<AuthCheck>;
  write: (line: ListenLine) => void;
  teamId: string;
  userId: string;
  timings?: Partial<ListenTimings>;
  now?: () => number;
  /** Socket scheme+host; tests point it at a local server. */
  baseUrl?: string;
  /** Overrides DEFAULT_AGENT_VERSION. */
  agentVersion?: string;
}

/** Bun's WebSocket accepts request headers, which the upgrade needs for the cookie. */
export function defaultConnect(url: string, headers: Record<string, string>): SocketLike {
  const Ws = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => SocketLike;
  return new Ws(url, { headers });
}

interface Attempt {
  gotHello: boolean;
  error: string;
  upFor: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/**
 * Run until `signal` aborts (returns 0) or Slack refuses the login (returns 2).
 * Writes one line per event, one `hello` per connection and one `disconnected`
 * per ended attempt.
 */
export async function listen(
  config: Pick<BrowserAuthConfig, 'xoxc_token' | 'xoxd_token' | 'workspace_id'>,
  deps: ListenDeps,
  signal: AbortSignal,
): Promise<number> {
  const t = { ...DEFAULT_TIMINGS, ...deps.timings };
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const url = buildSocketUrl(config, deps.baseUrl, deps.agentVersion || DEFAULT_AGENT_VERSION);
  const headers = socketHeaders(config);
  let backoff = t.backoffMin;

  const attempt = () =>
    new Promise<Attempt>((resolve) => {
      const started = now();
      let lastFrame = started;
      let lastTick = started;
      let gotHello = false;
      let error = '';
      let finished = false;
      let pingId = 0;
      let ws: SocketLike | null = null;

      const finish = (reason: string) => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        clearInterval(pinger);
        signal.removeEventListener('abort', onAbort);
        try {
          ws?.close(1000, 'listen closing');
        } catch {
          // already closed
        }
        resolve({ gotHello, error: redact(error || reason), upFor: now() - started });
      };
      const onAbort = () => finish('stopped');
      signal.addEventListener('abort', onAbort);

      const watchdog = setInterval(() => {
        const n = now();
        if (n - lastTick > t.wakeCheck + t.wakeThreshold) return finish('machine woke from sleep');
        lastTick = n;
        if (!gotHello && n - started > t.helloTimeout) return finish(`no hello within ${Math.round(t.helloTimeout / 1000)}s`);
        if (n - lastFrame > t.idleTimeout) return finish(`no frames for ${Math.round(t.idleTimeout / 1000)}s`);
      }, Math.max(10, Math.min(5_000, t.wakeCheck, t.idleTimeout / 4, t.helloTimeout / 4)));
      const pinger = setInterval(() => {
        if (gotHello) ws?.send(JSON.stringify({ id: ++pingId, type: 'ping' }));
      }, t.pingEvery);

      try {
        ws = deps.connect(url, headers);
      } catch (e) {
        return finish(`connect failed: ${String((e as Error).message ?? e)}`);
      }
      ws.onmessage = (ev) => {
        lastFrame = now();
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (!gotHello) {
          let f: Frame | null = null;
          try {
            f = JSON.parse(raw);
          } catch {
            // not JSON: parseFrame below ignores it
          }
          if (f?.type === 'hello') {
            gotHello = true;
            deps.write({ type: 'hello', at: iso(), team_id: deps.teamId, user_id: deps.userId });
            return;
          }
          // The gateway refuses a session with an error frame before hello; say why.
          if (f?.type === 'error') {
            const msg = String(f.error?.msg ?? 'unknown');
            const hint = msg === 'force_reload' ? ' (the agent version is no longer accepted: pass a newer --agent-version)' : '';
            return finish(`slack error before hello: ${msg} (code ${f.error?.code ?? '?'})${hint}`);
          }
        }
        const line = parseFrame(raw, deps.userId, iso());
        if (line) deps.write(line);
      };
      ws.onerror = () => {
        error ||= 'socket error';
      };
      ws.onclose = (ev) => finish(ev?.reason ? `closed: ${ev.reason}` : `closed (code ${ev?.code ?? '?'})`);
    });

  while (!signal.aborted) {
    const a = await attempt();
    deps.write({ type: 'disconnected', at: iso(), error: a.error });
    if (signal.aborted) break;
    if (!a.gotHello && (await deps.checkAuth()) === 'refused') return 2;
    if (a.upFor >= t.stableAfter) backoff = t.backoffMin;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, t.backoffMax);
  }
  return 0;
}
