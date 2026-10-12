# Autopia plugin and hosted server: terms of use

Last updated 2026-10-12.

**What this is.** The plugin and the hosted compendium server at
`https://autopia-mcp.onrender.com/mcp` give AI agents verified descriptions of how public
HTTP APIs behave. The software is open source under the MIT License (see the LICENSE file at
the repository root); these terms cover use of the hosted service.

**No warranty.** Every claim the compendium serves was produced by probing a live API and
reproduced before it was stored, but APIs change. Claims are provided as is, with no guarantee
that they are current, complete, or fit for any purpose. Verify before relying on them for
anything that matters.

**Availability.** The service runs on free hosting tiers and may be slow to wake, rate
limited, or taken offline at any time without notice. Anonymous reads are limited per address
(currently 30 requests per minute and 300 per day). Keys carry their own quota. There is no
service-level commitment of any kind.

**Acceptable use.** Do not attempt to exceed the rate limits, scrape the service in bulk,
probe it for vulnerabilities, or use it to attack the APIs it describes. The server operator
may revoke keys and block addresses that do so.

**Your data.** What the plugin sends and what the server keeps is described in
[PRIVACY.md](PRIVACY.md).

**Changes.** These terms may change; the current version is always the file at
https://github.com/MaydayTrey/autopia/blob/main/plugin/TERMS.md.

**Contact.** https://github.com/MaydayTrey/autopia/issues.
