import { Command } from 'commander';
import { effectiveSelection, selectWorkspace } from '../lib/auth.ts';
import { failCommand } from '../lib/command-errors.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { defaultConnect, listen, redact, type AuthCheck, type ListenLine } from '../lib/listen.ts';
import { SlackClient } from '../lib/slack-client.ts';

// --help content, kept apart from the command chain below (#324).
const HELP = {
  summary: 'Stream new messages as JSON lines (live)',
  description:
    "Stay connected to Slack's web-client event socket and print one JSON object per line for " +
    'every new message, edit, deletion, reaction and read marker, about a second after it happens, ' +
    'until interrupted. Meant for agents and scripts that would otherwise poll ' +
    '"conversations unread". Needs a browser login (xoxc/xoxd): the socket is the one the Slack ' +
    'web client uses, not a documented API, so it may change without notice.',
  examples: [
    'slackcli listen',
    'slackcli listen --workspace acme | jq -c \'select(.type == "message" and (.mentions_me or .is_dm))\'',
  ],
  notes: [
    'Output is always JSON, one object per line, each with `type` and `at` (ISO time): ' +
      'hello { team_id, user_id } once per connection; ' +
      'message { channel_id, ts, thread_ts?, user?, bot_id?, subtype?, text, changed, mentions_me, is_dm }; ' +
      'message_deleted { channel_id, ts }; reaction_added / reaction_removed { channel_id, ts, user_id, emoji }; ' +
      'channel_marked { channel_id, ts }; thread_marked { channel_id, thread_ts, ts }; ' +
      'disconnected { error } after every connection that ended.',
    'Reconnects by itself (1s → 30s backoff). After every `disconnected` line, catch up on what may ' +
      'have been missed, e.g. with "conversations unread".',
    'Exits 0 on Ctrl-C / SIGTERM, and 2 when Slack refuses the login: sign in again with ' +
      '"slackcli auth login-auto".',
    'Standard tokens (xoxp/xoxb, SLACKCLI_TOKEN) cannot open this socket.',
    'A `disconnected` error of force_reload means Slack retired the web build listen presents; ' +
      'pass a newer one with --agent-version.',
  ],
} satisfies CommandHelp;

/** Map an auth.test failure to whether the login itself is gone or Slack is just unreachable. */
export function classifyAuthError(err: unknown): AuthCheck {
  const text = String((err as Error)?.message ?? err);
  return /invalid_auth|not_authed|token_revoked|token_expired|account_inactive|user_removed/.test(text)
    ? 'refused'
    : 'unreachable';
}

export function createListenCommand(): Command {
  return describeCommand(new Command('listen'), HELP)
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--agent-version <build-ts>', 'Slack web build timestamp to present (default: a known-good one; env SLACKCLI_AGENT_VERSION)')
    .action(async (options) => {
      try {
        const selection = effectiveSelection(options.workspace, process.env);
        if (selection.source === 'env_token') {
          throw new Error('listen needs a browser login (xoxc/xoxd); a token from the environment cannot open the event socket');
        }
        const config = await selectWorkspace(selection);
        if (config.auth_type !== 'browser') {
          throw new Error('listen needs a browser login (xoxc/xoxd). Sign in with: slackcli auth login-auto');
        }
        const client = new SlackClient(config);
        // Who "me" is for mentions_me; also fails fast on a dead login.
        const me = await client.testAuth();
        const checkAuth = async (): Promise<AuthCheck> => {
          try {
            await client.testAuth();
            return 'ok';
          } catch (err) {
            return classifyAuthError(err);
          }
        };

        const stop = new AbortController();
        process.once('SIGINT', () => stop.abort());
        process.once('SIGTERM', () => stop.abort());
        const write = (line: ListenLine) => {
          process.stdout.write(`${JSON.stringify(line)}\n`);
        };
        const code = await listen(
          config,
          {
            connect: defaultConnect,
            checkAuth,
            write,
            teamId: me.team_id ?? config.workspace_id,
            userId: me.user_id ?? config.user_id ?? '',
            agentVersion: options.agentVersion ?? process.env.SLACKCLI_AGENT_VERSION,
          },
          stop.signal,
        );
        if (code === 2) process.stderr.write('Slack refused the login. Sign in again with: slackcli auth login-auto\n');
        process.exit(code);
      } catch (err) {
        failCommand(new Error(redact(String((err as Error)?.message ?? err))));
      }
    });
}
