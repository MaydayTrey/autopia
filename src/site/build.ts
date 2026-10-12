/**
 * STATIC SITE: the compendium where agents already look. Web searches for an error string
 * ("Validation Failed issue_field_values") should land on a page that cites reproduced trials,
 * with no plugin and no MCP connection. Made for agents first: plain, dense, one fact per line.
 *
 * Output (under --out):
 *   index.html / index.md      the catalogue: every API, its hosts, counts, links
 *   llms.txt                   the AI-crawler index (llmstxt.org convention): what is here, one line per page
 *   <tool>/index.html / .md    the full behavior sheet
 *   <tool>/<endpoint>.html/.md the sheet scoped to one endpoint
 *   errors.html / errors.md    every quoted error message in the claims -> host, endpoint, claim, trials
 *   sitemap.xml, robots.txt
 *
 * The HTML is the Markdown with the lightest possible conversion (headings, lists, paragraphs,
 * escaped text) so the pages are crawlable as HTML and readable as text. Each page links its
 * .md twin and the MCP call that returns the same thing live.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { renderToolDocs } from '../db/docs.js';
import { listTools, toolKnowledge, type ClaimView } from '../db/queries.js';

export interface SiteOptions {
  /** A directory whose files are copied verbatim into the site root (search-engine verification files, favicons). Skipped when absent. */
  staticDir?: string;
  out: string;
  /** Absolute site root, no trailing slash, e.g. https://maydaytrey.github.io/autopia */
  base: string;
  /** Hosted MCP endpoint named on every page. */
  mcpUrl?: string;
}

/** File-safe slug for an endpoint label: "GET /repos/{owner}/{repo}/issues" -> "get-repos-owner-repo-issues". */
export function endpointSlug(endpoint: string): string {
  return endpoint
    .toLowerCase()
    .replace(/[{}]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The lightest Markdown -> HTML that keeps structure crawlable: headings, bullet lists, paragraphs; inline markup is left as text. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) out.push('</ul>');
    inList = false;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const id = endpointSlug(h[2]).slice(0, 80);
      out.push(`<h${level} id="${id}">${escapeHtml(h[2])}</h${level}>`);
      continue;
    }
    if (/^- /.test(line)) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (line === '') continue;
    out.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function page(title: string, description: string, bodyHtml: string, links: { md: string; live?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow">
<style>body{font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:960px;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}h1,h2,h3{line-height:1.25}li{margin:.25rem 0}nav{font-size:13px;color:#555}a{color:#0645ad}</style>
</head>
<body>
<nav><a href="${escapeHtml(links.md)}">plain text (.md)</a>${links.live ? ` · live: <code>${escapeHtml(links.live)}</code>` : ''} · <a href="../index.html">catalogue</a> · <a href="../errors.html">error messages</a></nav>
${bodyHtml}
</body>
</html>
`;
}

export interface ErrorRow {
  message: string;
  host: string;
  tool: string;
  endpoint: string;
  status: number;
  statement: string;
  trialIds: number[];
}

/** Every quoted error message the claims record, with where it came from: the searchable index. */
export function extractErrors(tool: string, hosts: string[], claims: ClaimView[]): ErrorRow[] {
  const rows: ErrorRow[] = [];
  const host = hosts[0] ?? tool;
  for (const c of claims) {
    const re = /HTTP (\d{3}) "([^"]{3,200})"/g;
    for (const m of c.statement.matchAll(re)) {
      rows.push({ message: m[2], host, tool, endpoint: c.endpoint, status: Number(m[1]), statement: c.statement, trialIds: c.evidence.map((e) => e.id) });
    }
  }
  return rows;
}

export async function buildSite(db: Db, opts: SiteOptions): Promise<{ pages: number; errors: number }> {
  const base = opts.base.replace(/\/+$/, '');
  const mcp = opts.mcpUrl ?? 'https://autopia-mcp.onrender.com/mcp';
  const tools = (await listTools(db)).filter((t) => t.verified_claims > 0);
  const urls: string[] = [];
  const llms: string[] = [
    '# Autopia: verified HTTP API behavior',
    '',
    '> A compendium of how public HTTP APIs actually behave, produced by probing each API with a deterministic battery, reproducing every finding, and recording the trials behind it. Where the OpenAPI spec is wrong, what it never says, real error bodies, pagination limits, auth tiers, date handling. Nothing is inferred from documentation.',
    '',
    `Live MCP server (anonymous reads): ${mcp}. Tools: get_tool_docs {tool, path?, brief?}, search_claims {query}, get_divergences {tool}, get_tool_knowledge {tool, kind}, list_tools.`,
    '',
    '## APIs',
  ];
  let pages = 0;
  let errorRows: ErrorRow[] = [];
  const catalogue: string[] = ['# Autopia: verified API behavior, by API', '', 'Each page is generated from reproduced claims; bracketed numbers are trial ids. Plain-text twins (.md) sit next to every page.', ''];

  await mkdir(opts.out, { recursive: true });
  for (const t of tools) {
    const dir = path.join(opts.out, t.name);
    await mkdir(dir, { recursive: true });
    const full = await renderToolDocs(db, t.name, null);
    if (!full) continue;
    const k = await toolKnowledge(db, t.name, null, false);
    const endpoints = [...new Set(k?.claims.map((c) => c.endpoint) ?? [])].sort();
    const hosts = (t.hosts as string[]) ?? [];
    const desc = `${t.name} (${hosts.join(', ')}): ${t.verified_claims} verified claims, ${t.divergences} contradict the spec, ${endpoints.length} endpoints probed.`;
    await writeFile(path.join(dir, 'index.md'), full);
    await writeFile(path.join(dir, 'index.html'), page(`${t.name}: verified API behavior (${hosts.join(', ')})`, desc, mdToHtml(full), { md: 'index.md', live: `get_tool_docs {"tool":"${t.name}"}` }));
    urls.push(`${base}/${t.name}/index.html`);
    pages++;
    llms.push(`- [${t.name}](${base}/${t.name}/index.md): ${desc}`);
    catalogue.push(`- [${t.name}](${t.name}/index.html) (${hosts.join(', ')}): ${t.verified_claims} claims, ${t.divergences} spec divergences, ${endpoints.length} endpoints`);
    for (const ep of endpoints) {
      const slug = endpointSlug(ep);
      const scoped = await renderToolDocs(db, t.name, null, { path: ep.replace(/^[A-Z]+ /, '') });
      if (!scoped) continue;
      await writeFile(path.join(dir, `${slug}.md`), scoped);
      await writeFile(path.join(dir, `${slug}.html`), page(`${ep} on ${hosts[0] ?? t.name}: verified behavior`, `Verified behavior of ${ep} (${t.name}): spec contradictions, undocumented rules, errors, pagination, validation, each line citing reproduced trials.`, mdToHtml(scoped), { md: `${slug}.md`, live: `get_tool_docs {"tool":"${t.name}","path":"${ep.replace(/^[A-Z]+ /, '')}"}` }));
      urls.push(`${base}/${t.name}/${slug}.html`);
      pages++;
      llms.push(`  - [${ep}](${base}/${t.name}/${slug}.md)`);
    }
    if (k) errorRows = errorRows.concat(extractErrors(t.name, hosts, k.claims));
  }

  // The error-message index: the page a search for an error string should land on.
  errorRows.sort((a, b) => a.host.localeCompare(b.host) || a.message.localeCompare(b.message) || a.status - b.status);
  const errMd: string[] = ['# Error messages, by API: what triggers each one', '', 'Every quoted error message the compendium has observed, with the exact condition that produced it and the trial ids that reproduce it. Search this page for the message you got.', ''];
  // One line per distinct message per host: "Bad credentials" on seven endpoints is one fact with seven places.
  const grouped = new Map<string, ErrorRow[]>();
  for (const r of errorRows) grouped.set(`${r.host}|${r.status}|${r.message}`, [...(grouped.get(`${r.host}|${r.status}|${r.message}`) ?? []), r]);
  let currentHost = '';
  for (const rows of grouped.values()) {
    const r = rows[0];
    if (r.host !== currentHost) {
      currentHost = r.host;
      errMd.push('', `## ${r.host} (${r.tool})`, '');
    }
    const eps = [...new Set(rows.map((x) => x.endpoint))];
    const where = eps.length === 1 ? `on ${eps[0]}` : `on ${eps.length} endpoints (${eps.join(', ')})`;
    const trials = [...new Set(rows.flatMap((x) => x.trialIds))].slice(0, 4).map((i) => `#${i}`).join(', ');
    errMd.push(`- HTTP ${r.status} "${r.message}" ${where}: ${r.statement} [${trials}] (${r.tool}/${endpointSlug(eps[0])}.html)`);
  }
  const errText = errMd.join('\n');
  await writeFile(path.join(opts.out, 'errors.md'), errText);
  await writeFile(path.join(opts.out, 'errors.html'), page('API error messages and what triggers them (verified)', `${errorRows.length} observed error messages across ${tools.length} APIs, each with the exact triggering condition and reproduced trials.`, mdToHtml(errText), { md: 'errors.md', live: 'search_claims {"query":"<the error message>"}' }).replace('href="../index.html"', 'href="index.html"').replace('href="../errors.html"', 'href="errors.html"'));
  urls.push(`${base}/errors.html`);
  llms.push('', '## Error messages', `- [All observed error messages, with triggers and trials](${base}/errors.md)`);

  catalogue.push('', `[All observed error messages and what triggers them](errors.html)`, '', `Live MCP server (anonymous reads): ${mcp}`);
  const catText = catalogue.join('\n');
  await writeFile(path.join(opts.out, 'index.md'), catText);
  await writeFile(path.join(opts.out, 'index.html'), page('Autopia: verified HTTP API behavior', `Verified, reproduced behavior of ${tools.length} public APIs: where the spec is wrong, what it never says, real errors, pagination, auth.`, mdToHtml(catText), { md: 'index.md' }).replace('href="../index.html"', 'href="index.html"').replace('href="../errors.html"', 'href="errors.html"'));
  urls.push(`${base}/index.html`);
  await writeFile(path.join(opts.out, 'llms.txt'), llms.join('\n') + '\n');
  await writeFile(path.join(opts.out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  await writeFile(path.join(opts.out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  await writeFile(path.join(opts.out, '.nojekyll'), '');
  // Verbatim files (site-static/ in the repo): Search Console / Bing verification files live here.
  if (opts.staticDir && existsSync(opts.staticDir)) await cp(opts.staticDir, opts.out, { recursive: true });
  return { pages: pages + 2, errors: errorRows.length };
}
