# Draft issue for github/rest-api-description

Where to file: https://github.com/github/rest-api-description/issues/new (the public repository
that holds GitHub's OpenAPI description, which generates their SDKs and docs). Title and body
below; paste as-is, then attach or link the evidence. Keep the tone factual: these are
reproducible observations, not complaints. If maintainers ask for a reproduction, every bullet
below is a single curl.

Evidence source: Autopia run #52 (2026-10-13) against api.github.com with a fine-grained token,
spec `descriptions/api.github.com/api.github.com.json` at hash 265c7bd16984 (spec version
1.1.4). Each claim was observed and then reproduced on a second request before being recorded.
Trial ids in brackets refer to the compendium's stored requests; the live sheet is
`get_tool_docs {"tool":"github-rest"}` on the Autopia MCP server, or `npm run autopia -- claims
github-rest --divergences` from a checkout.

---

**Title:** Several query parameters are documented as `integer` or with an `enum` but the API accepts any value (page, per_page, sort, order, direction)

**Body:**

While probing the REST API against this description, I found a consistent gap between the
documented parameter schemas and the live behavior of `api.github.com`. In every case the
description constrains the parameter and the API accepts values outside the constraint with
HTTP 200, so clients generated from the description will validate inputs the API itself does
not, and clients that trust the API will not see an error the description implies.

Observed on 2026-10-13 (API version header `2022-11-28`), each reproduced on a second request:

**`page` and `per_page` are declared `type: integer` but accept a non-integer string.**

| Endpoint | Request | Result |
|---|---|---|
| `GET /repos/{owner}/{repo}/commits` | `?per_page=abc` | 200, a normal page |
| `GET /repos/{owner}/{repo}/commits` | `?page=abc` | 200, a normal page |
| `GET /repos/{owner}/{repo}/issues` | `?per_page=abc` / `?page=abc` | 200 |
| `GET /repos/{owner}/{repo}/releases` | `?per_page=abc` / `?page=abc` | 200 |
| `GET /search/repositories` | `?q=...&per_page=abc` / `?page=abc` | 200 |

(Repository used: `github/rest-api-description`.) By contrast, out-of-range values *are* handled:
`per_page=100000` is clamped to 100 on commits and issues, and large `page` values on issues,
releases and search return 422 with a descriptive message. The type itself is not validated.

**`sort`, `order` and `direction` are declared with an `enum` but accept an undocumented value.**

| Endpoint | Parameter | Documented enum | Request | Result |
|---|---|---|---|---|
| `GET /repos/{owner}/{repo}/issues` | `sort` | created, updated, comments | `?sort=not_a_documented_value` | 200 |
| `GET /repos/{owner}/{repo}/issues` | `direction` | asc, desc | `?direction=not_a_documented_value` | 200 |
| `GET /search/repositories` | `sort` | stars, forks, help-wanted-issues, updated | `?q=...&sort=not_a_documented_value` | 200 |
| `GET /search/repositories` | `order` | asc, desc | `?q=...&order=not_a_documented_value` | 200 |

It is not visible from the response whether the undocumented value is ignored or applied as a
default; the response is a normal page either way.

**Why this matters for consumers**

- Generated SDKs (and agents reading the description) reject inputs the API accepts, and
  cannot rely on the API to reject typos in `sort`/`order`/`direction`, which silently return a
  differently ordered page.
- A description-based mock or contract test will disagree with production.

**Suggested resolution**

Either validate these parameters server-side (returning 422 as the API already does for other
invalid inputs on these endpoints), or relax the description to match: drop the `enum` on the
sort/order/direction parameters or document that unknown values fall back to the default, and
note that `page`/`per_page` are parsed leniently.

I can provide the exact request/response pairs for each row on request.

---

Related observations from the same run that are *not* description bugs but may be worth a docs
note (open separately if useful):

- `GET /repos/{owner}/{repo}/commits?since=not-a-date` returns 200 with an empty list, while
  `GET /repos/{owner}/{repo}/issues?since=not-a-date` returns 422 "The since parameter needs to
  be in ISO 8601 format". The two endpoints treat the same invalid input differently, and the
  commits behavior gives the caller no signal that the filter was unusable.
- `GET /repos/{owner}/{repo}/issues?issue_field_values=test` returns 422 "Validation Failed" with
  no detail about the expected format; the description does not say what the parameter accepts.
