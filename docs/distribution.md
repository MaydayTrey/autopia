# Distribution: where Autopia gets listed, and the steps that need the maintainer's accounts

Everything here was checked against the official docs on 2026-10-13 (MCP Registry docs and
schema at `modelcontextprotocol/registry`; Claude Code plugin docs at code.claude.com; the
Claude directory submission docs at claude.com/docs/plugins/submit). Re-check before relying on
a detail; the registry still calls itself a preview.

## 1. GitHub Pages (the static site)

One-time: repository Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**.
Then Actions -> `pages` -> Run workflow (or wait for the daily 07:45 UTC run). Site:
`https://maydaytrey.github.io/autopia/`; `llms.txt` at the root is the quickest check.

## 2. MCP Registry (registry.modelcontextprotocol.io)

The manifest is `server.json` at the repo root (name `io.github.MaydayTrey/autopia`: the
namespace must match the GitHub login's exact casing; remote type `streamable-http`; no
`packages` for a remote-only server; description under 100 characters; `version` immutable
once published, so bump it for every change).

Install the publisher (Windows PowerShell; macOS/Linux: `brew install mcp-publisher`):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile mcp-publisher.tar.gz
tar xf mcp-publisher.tar.gz mcp-publisher.exe
Remove-Item mcp-publisher.tar.gz
```

Then, from the repo root:

```powershell
.\mcp-publisher.exe validate server.json
.\mcp-publisher.exe login github          # device flow: open the printed URL, enter the code
.\mcp-publisher.exe publish server.json
```

Verify: `https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.MaydayTrey/autopia`.

Later: a new release is a new `version` in `server.json` and `publish` again. Retire one with
`mcp-publisher status --status deprecated --message "Use 0.4.0" io.github.MaydayTrey/autopia 0.3.0`.
The registry does not probe the URL, but its moderation policy removes servers that are down;
keep the Render service healthy.

## 3. Claude plugin directory (the community marketplace)

Anthropic's official marketplace takes no open submissions, and the community marketplace
repository is a read-only mirror that auto-closes pull requests. The route is the **Claude
directory portal**, which needs a paid claude.ai plan on the submitting account and the GitHub
account connected with push access to the repo:

1. `claude plugin validate ./plugin --strict` passes (it does; the portal applies a few rules
   the CLI does not).
2. Open `https://claude.ai/directory/manage` -> Submit new -> **Plugin bundle**.
3. Source: repository `MaydayTrey/autopia`, path `plugin`, tracked branch `main`. Validate.
4. Listing details are read from `plugin/.claude-plugin/plugin.json` and `plugin/README.md`;
   answer the data-handling questions (the hook sends only the matched host and request path,
   never command text or file content; the server logs calls per key or per address for rate
   limiting) and the four compliance acknowledgements. Submit for review.
5. An automated security scan runs, then a reviewer publishes. Approved plugins appear in the
   directory and are mirrored nightly into `anthropics/claude-plugins-community` as
   `autopia@claude-community`.
6. Updates: push to `main` and bump `version` in `plugin.json` each release; the portal tracks
   the branch. Ten submissions per account per day; one per repo+folder.

The docs also say a plugin that references a remote MCP server the author runs should submit
that server separately as an **MCP connector** (same portal, "MCP connector"); do that after the
registry entry exists.

## 4. Upstream: GitHub's OpenAPI description

The divergences on page/per_page (typed integer, unvalidated) and sort/order/direction (enum,
unvalidated) are worth filing against github/rest-api-description as a "Schema Inaccuracy",
linking the public GitHub page of this site for the evidence. The maintainer files it from
his own account; the text is not kept in this repository.
