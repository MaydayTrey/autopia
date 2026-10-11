---
name: autopia
description: Verified HTTP API behavior from the Discrimen Compendium. TRIGGER before the first request in a session to any covered host (api.github.com, registry.npmjs.org, pypi.org, api.anthropic.com, api.open-meteo.com, api.weather.gov, pokeapi.co, openlibrary.org, api.binance.com, api.frankfurter.dev, date.nager.at), whenever the task is "call / curl / fetch / integrate with / write a client for" an HTTP API, and AFTER an API call fails or surprises you (unexpected 4xx/5xx, a parameter that seems ignored, an odd or empty page, wrong filter results). SKIP for hosts the compendium does not list, for write endpoints (POST/PUT/DELETE are not probed yet), and for a sheet already read this session.
---

# Autopia: check verified behavior before you call an API

The compendium holds claims about live API behavior that were produced by probing the API and reproduced on a re-run before being stored. Each claim cites the trial ids behind it. It records what the OpenAPI spec gets wrong and what it never says: parameters silently ignored or clamped, the real error body per status, what happens past the last page, auth and rate-limit tiers, accepted date formats, undocumented required combinations.

## Before the first call to a covered host

1. Call the MCP tool `get_tool_docs` with the host or URL you are about to call, for example `{"tool":"api.github.com"}`. If the Autopia MCP server is not connected, `list_tools` is not available either; ask the user to configure the plugin (`claude plugin configure autopia`).
2. Read the first two sections first: where behavior contradicts the spec, and rules the spec never states. Then the endpoint you need.
3. Do not read the same sheet twice in a session. The plugin's hook may already have injected it before your Bash or WebFetch call; if the sheet is in your context, skip step 1.

## After a failed or surprising call

Call `search_claims` with the host and the symptom, e.g. `{"query":"github per_page 500"}` or `{"query":"npm search size 0"}`. Cite the trial ids when you explain the behavior to the user.

## Trust

Claims from the `server` tier were re-verified by the compendium server on the run shown in the sheet. `contributor-verified` claims were run by a keyed user and not re-run since; the date tells you how stale they are. Nothing in a sheet is inferred from documentation.
