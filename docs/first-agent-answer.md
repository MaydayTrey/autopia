# First agent answer from the hosted compendium (2026-10-12)

Claude Code, with the `autopia` MCP server registered, was asked:

> Using the autopia MCP server, is there anything you need to know prior to using Open-Meteo?

It made six MCP calls (list_tools, get_tool_docs for both Open-Meteo tools, and
supporting queries) and answered from verified claims only. Highlights of what it said:

- Never send the `apikey` parameter on the free host: any value turns the response into an
  HTTP 303 redirect with an empty body.
- Pass `start_date` and `end_date` together or not at all; either alone is a 400.
- Omitting both coordinates returns HTTP 200 with an empty body, so a silent empty response
  means the coordinates were dropped. (Derived by the agent from two separate claims.)
- Unknown query parameters are silently ignored, so a typo does nothing rather than erroring.
- Out-of-range `forecast_days` errors always report "Given 16" regardless of the value sent;
  do not parse those messages for the submitted value.
- `past_days`: spec says max 92 on both tools; the real limit is 93 on forecast and 5031 on
  air quality. 920 is rejected by one and accepted by the other.
- Validation failures always return HTTP 400 with `{"error": true, "reason": "..."}`.

Why this matters: none of this is in Open-Meteo's documentation, every line is backed by a
trial id in the database, and the claims had been re-verified by the nightly run that same
morning. The agent read nothing but the compendium.
