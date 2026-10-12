/**
 * KILL SWITCH for the hosted compendium. Stops the public server and the database compute in
 * one command, and brings them back in one command.
 *
 *   npm run kill            suspend the Render web service and the Neon compute
 *   npm run revive          resume both
 *   npm run kill:status     show what is up and what is down
 *
 * Needs two API keys in .env (or the environment), each created in the provider's dashboard:
 *   RENDER_API_KEY     Render Dashboard -> Account Settings -> API Keys
 *   NEON_API_KEY       Neon Console -> Account settings -> API keys
 * Optional, discovered automatically when missing:
 *   RENDER_SERVICE_ID  srv-...   (the service named autopia-mcp)
 *   NEON_PROJECT_ID, NEON_ENDPOINT_ID   (the first project / its compute endpoint)
 *
 * Without the keys the command prints the exact manual steps instead, so it is still the one
 * place to look when something has to be shut down. Nothing here can create a bill: neither
 * provider has a card on file, and suspending only ever reduces usage.
 *
 * Cheaper first step, no API keys needed: set AUTOPIA_OFFLINE=1 in the Render service's
 * environment. The server then answers 503 to everything but /healthz and never opens the
 * database. Unset it to resume.
 */
import { loadEnv } from '../src/worker/env.js';

loadEnv();
const action = (process.argv[2] ?? 'status') as 'kill' | 'revive' | 'status';
if (!['kill', 'revive', 'status'].includes(action)) {
  console.error('usage: kill-switch.ts kill | revive | status');
  process.exit(2);
}

const RENDER = 'https://api.render.com/v1';
const NEON = 'https://console.neon.tech/api/v2';
const renderKey = process.env.RENDER_API_KEY?.trim();
const neonKey = process.env.NEON_API_KEY?.trim();

async function call(url: string, key: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, body };
}

const MANUAL = `
MANUAL STEPS (no API keys needed; each is one click in a dashboard):
  1. Stop serving instantly, keep the service: Render Dashboard -> autopia-mcp -> Environment ->
     add AUTOPIA_OFFLINE = 1 -> Save (redeploys in ~1 min; everything but /healthz answers 503).
  2. Stop the web service entirely: Render Dashboard -> autopia-mcp -> Settings -> Suspend Web Service.
  3. Stop the database compute: Neon Console -> project -> Branches -> compute -> Suspend
     (or simply leave it: it autosuspends after 5 idle minutes and has no card on file).
  4. Stop the scheduled jobs (the only thing that spends real money, the Anthropic key):
     GitHub -> Actions -> run-all-llm (and run-all, pages) -> "..." -> Disable workflow.
  5. Cap the one billed account: console.anthropic.com -> Billing -> set a monthly spend limit.
  Resume by reversing the same steps (Render: Resume Web Service / remove AUTOPIA_OFFLINE;
  Neon computes start on the first connection; GitHub: Enable workflow).
`;

async function renderService(): Promise<{ id: string; name: string; suspended: string } | null> {
  if (!renderKey) return null;
  if (process.env.RENDER_SERVICE_ID) {
    const r = await call(`${RENDER}/services/${process.env.RENDER_SERVICE_ID}`, renderKey);
    const s = r.body as { id: string; name: string; suspended: string };
    return r.status === 200 ? { id: s.id, name: s.name, suspended: s.suspended } : null;
  }
  const r = await call(`${RENDER}/services?type=web_service&limit=100`, renderKey);
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`Render list services: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const items = r.body as { service: { id: string; name: string; suspended: string } }[];
  const hit = items.find((i) => i.service.name === 'autopia-mcp') ?? items[0];
  return hit ? { id: hit.service.id, name: hit.service.name, suspended: hit.service.suspended } : null;
}

async function neonEndpoint(): Promise<{ projectId: string; endpointId: string; state: string } | null> {
  if (!neonKey) return null;
  let projectId = process.env.NEON_PROJECT_ID;
  if (!projectId) {
    const r = await call(`${NEON}/projects`, neonKey);
    if (r.status !== 200) throw new Error(`Neon list projects: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const projects = (r.body as { projects: { id: string; name: string }[] }).projects;
    projectId = (projects.find((p) => /autopia/i.test(p.name)) ?? projects[0])?.id;
    if (!projectId) return null;
  }
  const e = await call(`${NEON}/projects/${projectId}/endpoints`, neonKey);
  if (e.status !== 200) throw new Error(`Neon list endpoints: HTTP ${e.status} ${JSON.stringify(e.body).slice(0, 200)}`);
  const endpoints = (e.body as { endpoints: { id: string; current_state: string; type: string }[] }).endpoints;
  const ep = (process.env.NEON_ENDPOINT_ID ? endpoints.find((x) => x.id === process.env.NEON_ENDPOINT_ID) : endpoints.find((x) => x.type === 'read_write')) ?? endpoints[0];
  return ep ? { projectId, endpointId: ep.id, state: ep.current_state } : null;
}

async function main() {
  console.log(`kill-switch: ${action}`);
  if (!renderKey && !neonKey) {
    console.log('No RENDER_API_KEY / NEON_API_KEY configured, so nothing can be done from here.');
    console.log(MANUAL);
    return;
  }
  const svc = await renderService().catch((e: Error) => (console.log(`Render: ${e.message}`), null));
  const ep = await neonEndpoint().catch((e: Error) => (console.log(`Neon: ${e.message}`), null));

  if (svc) console.log(`Render: ${svc.name} (${svc.id}) is ${svc.suspended === 'suspended' ? 'SUSPENDED' : 'running'}`);
  else console.log(renderKey ? 'Render: no web service found' : 'Render: no RENDER_API_KEY (manual: Dashboard -> service -> Settings -> Suspend)');
  if (ep) console.log(`Neon: endpoint ${ep.endpointId} in project ${ep.projectId} is ${ep.state}`);
  else console.log(neonKey ? 'Neon: no endpoint found' : 'Neon: no NEON_API_KEY (it autosuspends when idle and has no card on file)');

  if (action === 'status') return;
  const verb = action === 'kill' ? 'suspend' : 'resume';
  if (svc && renderKey) {
    const r = await call(`${RENDER}/services/${svc.id}/${verb}`, renderKey, 'POST');
    console.log(`Render ${verb}: HTTP ${r.status}${r.status >= 300 ? ' ' + JSON.stringify(r.body).slice(0, 200) : ' ok'}`);
  }
  if (ep && neonKey) {
    const r = await call(`${NEON}/projects/${ep.projectId}/endpoints/${ep.endpointId}/${action === 'kill' ? 'suspend' : 'start'}`, neonKey, 'POST');
    console.log(`Neon ${action === 'kill' ? 'suspend' : 'start'}: HTTP ${r.status}${r.status >= 300 ? ' ' + JSON.stringify(r.body).slice(0, 200) : ' ok'}`);
  }
  if (action === 'kill') console.log('\nAlso consider: GitHub -> Actions -> disable run-all-llm (the only workflow that spends money), and a spend limit at console.anthropic.com.');
  else console.log('\nBack up. Render takes ~1 minute to restart; Neon is ready when its operation chain finishes.');
}

main().catch((e) => {
  console.error(e);
  console.log(MANUAL);
  process.exit(1);
});
