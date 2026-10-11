# Parked targets

Targets that are valid but not currently run by `run-all` (which only reads `targets/*.json`).

- `jikan.json`: api.jikan.moe timed out on every request from this network on 2026-10-11
  (even plain curl), so two runs produced nothing but transport errors. Re-check reachability
  with `curl -m 20 https://api.jikan.moe/v4/anime/1` and move the file back when it answers.
