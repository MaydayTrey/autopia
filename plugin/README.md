# Autopia plugin for Claude Code

Verified HTTP API behavior, delivered at the moment an agent needs it.

The plugin ships three things:

- **A PreToolUse hook** on `Bash` and `WebFetch`. When a command or fetch is about to touch a
  host the compendium covers (`api.github.com`, `registry.npmjs.org`, `pypi.org`,
  `api.anthropic.com`, the Open-Meteo APIs, ...), the hook injects that API's verified
  behavior sheet into the model's context: spec contradictions first, then undocumented rules,
  then per-endpoint behavior, every line citing reproduced trials. Once per host per session.
  It never blocks a call: if the server is unreachable or no key is configured, the call
  proceeds and nothing is injected.
- **A PostToolUse hook** on the same tools, the error path: when a call to a covered host comes
  back with a 4xx/5xx (an HTTP status line, or a JSON body with a status or an error message), it
  injects the verified claims that match the failure, compact, once per failure per session. The
  agent is already stuck and motivated; this is where a few hundred tokens are worth the most.
- **The Autopia MCP server**, registered for you, for digging further: `search_claims` when a
  call fails or surprises, `get_tool_docs` by host or URL, `get_divergences`, `list_tools`.
- **A skill** that tells the model when to consult the compendium even when the hook did not
  fire (for example, a call made through an SDK rather than curl).

## Install

Prerequisites: Claude Code 2.1.275 or newer and `node` (18+) on your PATH; the hook is a Node
script with no dependencies.

```bash
claude plugin install autopia --marketplace MaydayTrey/autopia
```

Reads on the hosted server are anonymous, so the plugin works with **no configuration**. A key
raises your quota and enables `request_target`; to set one (it goes to your OS credential store,
not to a settings file):

```bash
claude plugin configure autopia
```

Or, for a session-only trial from a checkout of this repo:

```bash
claude --plugin-dir ./plugin
```

Without a configured key the hook falls back to the environment variable `AUTOPIA_API_KEY`.

If a self-hosted server refuses anonymous reads (HTTP 401) and no key is configured, the hook
injects a one-line setup note the first time a command touches a covered host, once per
session. After updating the plugin (`claude plugin update autopia@autopia`) a configured key
carries over.

## Keys

The hosted server at `autopia-mcp.onrender.com` answers reads anonymously under a per-IP limit
(30 a minute, 300 a day) and a global daily budget; when the budget is spent, the hook simply
injects nothing until it resets. A per-user key (`ak_...`) gives you your own quota and the ability
to request new targets. Keys are issued by the maintainer; open an issue on the repository with
the name you want on the key. Self-service issuance is on the roadmap.

The plugin talks to the hosted server. If you run your own compendium server, set
`AUTOPIA_MCP_URL` to its `/mcp` endpoint for the hook, and edit the `url` in the plugin's
`.mcp.json` for the MCP tools.

## How the hook decides

1. It reads the tool input (the Bash command, or the WebFetch URL) and looks for covered hosts
   in URL shape only: `https://host/...` or `host/path`. A bare mention of a host (in an echo, a
   commit message, a JSON argument) does not fire. The host list comes from `list_tools` and is
   cached for a day; a bundled snapshot covers the first run and cold starts.
2. For each matched host and request path not yet injected in this session, it fetches the
   **brief** sheet **scoped to that endpoint** (`get_tool_docs` with `brief: true` and `path`:
   spec contradictions, undocumented rules, auth, pagination and error behavior for the endpoint
   the path matches, tool-wide auth behavior, and a one-line index of the other endpoints; cached
   for six hours) and returns it as `additionalContext`. A second endpoint on the same host gets
   its own small injection; the same endpoint never twice.
3. The injection is held to about 5KB (the largest brief sheet, GitHub, is 4.6KB), cut at a section boundary, with a pointer to the full
   sheet and to `search_claims`.

Set `AUTOPIA_HOOK_DEBUG=1` to see the hook's decisions on stderr. State lives in the plugin's
data directory (`CLAUDE_PLUGIN_DATA`, or `~/.autopia` when run outside Claude Code).

## Privacy

The hook sends the compendium server only the matched host or tool name, never your command,
query string, or any file content; with endpoint scoping it also sends the request path, with
any query string removed. The server logs tool calls per key (or anonymously, per address, for
rate limiting) for quota purposes.
