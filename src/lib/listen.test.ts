import { describe, expect, test } from 'bun:test';
import {
  buildSocketUrl,
  defaultConnect,
  listen,
  parseFrame,
  redact,
  socketHeaders,
  type ListenLine,
  type SocketLike,
} from './listen.ts';

const config = { xoxc_token: 'xoxc-123-abc', xoxd_token: 'xoxd-a/b+c=', workspace_id: 'T0TEAM' };
const AT = '2026-11-13T00:00:00.000Z';
const fast = { backoffMin: 5, backoffMax: 20, stableAfter: 10_000, idleTimeout: 200, helloTimeout: 150, pingEvery: 50, wakeCheck: 10_000, wakeThreshold: 10_000 };

describe('socket address and headers', () => {
  test('token, team and start args in the query', () => {
    const url = new URL(buildSocketUrl(config));
    expect(url.origin).toBe('wss://wss-primary.slack.com');
    expect(url.searchParams.get('token')).toBe('xoxc-123-abc');
    expect(url.searchParams.get('gateway_server')).toBe('T0TEAM-1');
    expect(url.searchParams.get('start_args')).toContain('connect_only=true');
    // An empty agent_version makes the gateway accept the upgrade and then stay silent.
    expect(url.searchParams.get('start_args')).toMatch(/agent_version=\d{6,}&/);
    expect(new URL(buildSocketUrl(config, undefined, '1799999999')).searchParams.get('start_args')).toContain('agent_version=1799999999&');
  });

  test('the d cookie is URL-encoded, like the HTTP transport does', () => {
    const h = socketHeaders(config);
    expect(h.Cookie).toBe(`d=${encodeURIComponent('xoxd-a/b+c=')}`);
    expect(h.Origin).toBe('https://app.slack.com');
  });

  test('redact strips tokens, the cookie and any URL query', () => {
    const text = `failed wss://wss-primary.slack.com/?token=xoxc-123-abc&x=1 with d=xoxd-zzz; and xoxc-999-q`;
    const out = redact(text);
    expect(out).not.toContain('xoxc-123');
    expect(out).not.toContain('xoxc-999');
    expect(out).not.toContain('xoxd-zzz');
    expect(out).toContain('?[REDACTED]');
  });
});

describe('frames → lines', () => {
  const p = (f: unknown) => parseFrame(JSON.stringify(f), 'UME', AT);

  test('a DM and a channel mention', () => {
    expect(p({ type: 'message', channel: 'D1', user: 'U1', text: 'hi', ts: '1.1' })).toMatchObject({ type: 'message', is_dm: true, mentions_me: false, changed: false });
    expect(p({ type: 'message', channel: 'C1', user: 'U1', text: '<@UME> look', ts: '1.2', thread_ts: '1.0' })).toMatchObject({ is_dm: false, mentions_me: true, thread_ts: '1.0' });
  });

  test('edits carry the new text; deletions only the ts', () => {
    expect(p({ type: 'message', subtype: 'message_changed', channel: 'C1', message: { ts: '1.2', text: 'now <@UME>', user: 'U1' } })).toMatchObject({ changed: true, mentions_me: true, ts: '1.2' });
    expect(p({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '1.2' })).toEqual({ type: 'message_deleted', at: AT, channel_id: 'C1', ts: '1.2' });
  });

  test('system notices, presence, pongs and garbage are dropped', () => {
    expect(p({ type: 'message', subtype: 'channel_join', channel: 'C1', ts: '1', text: 'joined' })).toBeNull();
    expect(p({ type: 'presence_change', user: 'U1' })).toBeNull();
    expect(p({ type: 'pong', reply_to: 1 })).toBeNull();
    expect(parseFrame('not json', 'UME', AT)).toBeNull();
  });

  test('reactions and read markers', () => {
    expect(p({ type: 'reaction_added', user: 'U1', reaction: 'eyes', item: { type: 'message', channel: 'C1', ts: '1.1' } })).toMatchObject({ type: 'reaction_added', emoji: 'eyes', channel_id: 'C1' });
    expect(p({ type: 'im_marked', channel: 'D1', ts: '2.0' })).toMatchObject({ type: 'channel_marked', channel_id: 'D1' });
    expect(p({ type: 'thread_marked', subscription: { channel: 'C1', thread_ts: '1.0', last_read: '1.5' } })).toMatchObject({ type: 'thread_marked', thread_ts: '1.0', ts: '1.5' });
  });
});

/** A socket that plays a script after it is created. */
function scripted(steps: Array<(s: SocketLike) => void>): SocketLike {
  const s: SocketLike = { send() {}, close() { s.onclose?.({ code: 1000 }); }, onopen: null, onmessage: null, onclose: null, onerror: null };
  queueMicrotask(() => steps.forEach((step) => step(s)));
  return s;
}

describe('connection loop', () => {
  test('hello, a message, a dropped socket; then a refused login ends the run with 2', async () => {
    const lines: ListenLine[] = [];
    let dials = 0;
    const code = await listen(config, {
      connect: () => {
        dials += 1;
        return dials === 1
          ? scripted([
              (s) => s.onmessage?.({ data: JSON.stringify({ type: 'hello' }) }),
              (s) => s.onmessage?.({ data: JSON.stringify({ type: 'message', channel: 'D1', user: 'U1', text: 'hi', ts: '1.1' }) }),
              (s) => s.onclose?.({ code: 1006 }),
            ])
          : scripted([(s) => s.onclose?.({ code: 1006 })]);
      },
      checkAuth: async () => (dials >= 2 ? 'refused' : 'ok'),
      write: (l) => lines.push(l),
      teamId: 'T0TEAM',
      userId: 'UME',
      timings: fast,
    }, new AbortController().signal);
    expect(code).toBe(2);
    expect(lines.map((l) => l.type)).toEqual(['hello', 'message', 'disconnected', 'disconnected']);
  });

  test('no hello in time: the attempt is closed and dialled again; abort ends with 0', async () => {
    const lines: ListenLine[] = [];
    const stop = new AbortController();
    let dials = 0;
    const done = listen(config, {
      connect: () => {
        dials += 1;
        if (dials === 2) setTimeout(() => stop.abort(), 20);
        return scripted([]);
      },
      checkAuth: async () => 'unreachable',
      write: (l) => lines.push(l),
      teamId: 'T0TEAM',
      userId: 'UME',
      timings: fast,
    }, stop.signal);
    expect(await done).toBe(0);
    expect(dials).toBe(2);
    expect((lines[0] as { error: string }).error).toContain('no hello');
  });

  test('an error frame before hello ends the attempt and says why', async () => {
    const lines: ListenLine[] = [];
    const stop = new AbortController();
    await listen(config, {
      connect: () => {
        setTimeout(() => stop.abort(), 20);
        return scripted([(s) => s.onmessage?.({ data: JSON.stringify({ type: 'error', error: { msg: 'force_reload', code: 19 } }) })]);
      },
      checkAuth: async () => 'ok',
      write: (l) => lines.push(l),
      teamId: 'T0TEAM',
      userId: 'UME',
      timings: fast,
    }, stop.signal);
    const err = (lines.find((l) => l.type === 'disconnected') as { error: string }).error;
    expect(err).toContain('force_reload');
    expect(err).toContain('--agent-version');
  });

  test('a thrown dial never leaks the token into the output', async () => {
    const lines: ListenLine[] = [];
    const stop = new AbortController();
    await listen(config, {
      connect: (url) => {
        setTimeout(() => stop.abort(), 10);
        throw new Error(`cannot reach ${url}`);
      },
      checkAuth: async () => 'unreachable',
      write: (l) => lines.push(l),
      teamId: 'T0TEAM',
      userId: 'UME',
      timings: fast,
    }, stop.signal);
    expect(JSON.stringify(lines)).not.toContain('xoxc-123');
  });
});

describe('against a real WebSocket server', () => {
  test('the upgrade carries the cookie and token; frames come out as lines', async () => {
    const seen: { cookie?: string | null; token?: string | null } = {};
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        seen.cookie = req.headers.get('cookie');
        seen.token = new URL(req.url).searchParams.get('token');
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: 'hello' }));
          ws.send(JSON.stringify({ type: 'message', channel: 'C1', user: 'U1', text: '<@UME> ping', ts: '9.9' }));
        },
        message() {},
      },
    });
    const lines: ListenLine[] = [];
    const stop = new AbortController();
    const run = listen(config, {
      connect: defaultConnect,
      checkAuth: async () => 'ok',
      write: (l) => {
        lines.push(l);
        if (l.type === 'message') stop.abort();
      },
      teamId: 'T0TEAM',
      userId: 'UME',
      timings: fast,
      baseUrl: `ws://127.0.0.1:${server.port}`,
    }, stop.signal);
    expect(await run).toBe(0);
    server.stop(true);
    expect(seen.cookie).toBe(`d=${encodeURIComponent('xoxd-a/b+c=')}`);
    expect(seen.token).toBe('xoxc-123-abc');
    expect(lines.slice(0, 2).map((l) => l.type)).toEqual(['hello', 'message']);
    expect(lines[1]).toMatchObject({ mentions_me: true, channel_id: 'C1' });
  });
});
