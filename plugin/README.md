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
- **The Autopia MCP server**, registered for you, for the error path: `search_claims` when a
  call fails or surprises, `get_tool_docs` by host or URL, `get_divergences`, `list_tools`.
- **A skill** that tells the model when to consult the compendium even when the hook did not
  fire (for example, a call made through an SDK rather than curl).

## Install

Prerequisites: Claude Code 2.1.275 or newer and `node` (18+) on your PATH; the hook is a Node
script with no dependencies.

```bash
claude plugin install autopia --marketplace MaydayTrey/autopia
```

Then configure your key, the only setting it asks for (the value goes to your OS credential
store, not to a settings file):

```bash
claude plugin configure autopia
```

Or, for a session-only trial from a checkout of this repo:

```bash
claude --plugin-dir ./plugin
```

Without a configured key the hook falls back to the environment variable `AUTOPIA_API_KEY`.

**Before the key is configured**, a session shows the `autopia` MCP server as failed to connect
(HTTP 401), and the hook injects a one-line setup note the first time a command touches a
covered host instead of a sheet. Both clear once the key is configured and a new session is
started. After updating the plugin (`claude plugin update autopia@autopia`) the configured key
carries over.

## Getting a key

The hosted server at `autopia-mcp.onrender.com` identifies every caller by a per-user key
(`ak_...`) with a daily quota. Keys are issued by the maintainer; open an issue on the
repository with the name you want on the key. Self-service issuance is on the roadmap.

The plugin talks to the hosted server. If you run your own compendium server, set
`AUTOPIA_MCP_URL` to its `/mcp` endpoint for the hook, and edit the `url` in the plugin's
`.mcp.json` for the MCP tools.

## How the hook decides

1. It reads the tool input (the Bash command, or the WebFetch URL) and looks for covered hosts
   in URL shape only: `https://host/...` or `host/path`. A bare mention of a host (in an echo, a
   commit message, a JSON argument) does not fire. The host list comes from `list_tools` and is
   cached for a day; a bundled snapshot covers the first run and cold starts.
2. For each matched host not yet injected in this session, it fetches the **brief** sheet
   (`get_tool_docs` with `brief: true`: spec contradictions, undocumented rules, auth,
   pagination and error behavior; cached for six hours) and returns it as `additionalContext`.
3. The injection is held to about 5KB (the largest brief sheet, GitHub, is 4.6KB), cut at a section boundary, with a pointer to the full
   sheet and to `search_claims`.

Set `AUTOPIA_HOOK_DEBUG=1` to see the hook's decisions on stderr. State lives in the plugin's
data directory (`CLAUDE_PLUGIN_DATA`, or `~/.autopia` when run outside Claude Code).

## Privacy

The hook sends the compendium server only the matched host or tool name, never your command,
URL path, query, or any file content. The server logs tool calls per key for quota purposes.
