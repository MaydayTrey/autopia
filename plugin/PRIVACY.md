# Autopia plugin: privacy

Last updated 2026-10-12. This covers the Claude Code plugin in this folder and the hosted
compendium server it talks to (`https://autopia-mcp.onrender.com/mcp`). Everything described
here is visible in the source: `plugin/scripts/` for the hooks, `src/server/mcp.ts` and
`src/db/keys.ts` for the server.

## What the hooks send

The PreToolUse hook runs before `Bash` and `WebFetch` calls. It looks for URL-shaped mentions
of hosts the compendium covers. When one matches, it asks the server for that endpoint's
behavior sheet. The request carries:

- the covered **host** and the **request path** of the URL you were about to call, with the
  query string removed (for example `api.github.com` and `/repos/{owner}/{repo}/issues`),
- your API key, if you configured one, as a bearer header over HTTPS.

It never sends the command text, file contents, the query string, headers, response bodies,
the session id, or anything about your project. If no covered host appears in the command, the
hook makes no network request at all.

The PostToolUse hook runs after a `Bash` or `WebFetch` call to a covered host fails with a
4xx/5xx. It sends the host, the request path and the **HTTP status and the error message text
returned by that API** as a search query, so the matching verified claims can be injected.
Nothing else from the output is sent.

## What the server keeps

For every tool call the server stores: the tool name, the target API name, success or
failure, duration, a timestamp, and who called:

- with a key: the key's id. Keys are stored as SHA-256 hashes; the server cannot recover a key.
- without a key: a salted, truncated SHA-256 hash of the client address (16 hex characters),
  used only to count distinct callers and enforce per-address rate limits. The address itself
  is not stored.

The hosting providers (Render for the server, Neon for the database) keep their own standard
access logs, which include client addresses, under their own retention policies. The server
sets no cookies and uses no analytics or third-party trackers. No data is sold or shared.

Call records are kept for usage statistics. To have records tied to your key removed, revoke
the key and open an issue at https://github.com/MaydayTrey/autopia/issues; anonymous records
cannot be tied to a person.

## What stays on your machine

Under the plugin's data directory (`CLAUDE_PLUGIN_DATA`, or `~/.autopia`): the cached host
list, cached behavior sheets, and one small file per Claude Code session recording which
sheets that session has already been shown (so nothing is injected twice). Delete the
directory at any time; it is rebuilt on the next call.

## The API key

The key is optional; reads work anonymously under per-address limits. It is collected only
through the plugin's user configuration prompt (`claude plugin configure autopia`), which
Claude Code stores as a sensitive setting. The hooks do not read it from any other file or
environment variable.

## Contact

Questions and requests: https://github.com/MaydayTrey/autopia/issues.
