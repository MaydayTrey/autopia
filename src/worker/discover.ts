/**
 * Stage 5.1 DISCOVER
 *   In:  a target (spec URL + name)
 *   Do:  fetch spec; validate it parses and has GET endpoints; hash it;
 *        create/find tool + tool_version rows.
 *   Out: { tool, version, parsed, isNewVersion }
 *   Fail: SpecError -> STOP. Out of scope.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { Tool, ToolVersion } from '../db/schema.js';
import { log } from './log.js';
import { extractEndpoints, fetchSpecText, hashSpec, parseSpecText, trimSpec, type ParsedSpec } from './spec.js';
import type { TargetConfig } from './target.js';

export interface DiscoverResult {
  tool: Tool;
  version: ToolVersion;
  parsed: ParsedSpec;
  isNewVersion: boolean;
}

export async function discover(db: Db, target: TargetConfig): Promise<DiscoverResult> {
  log.info('discover', `fetching spec ${target.spec_url}`);
  const text = await fetchSpecText(target.spec_url);
  const doc = parseSpecText(text);
  const parsed = extractEndpoints(doc, { server: target.server, overrideServer: target.override_server }); // throws SpecError if out of scope
  const specHash = hashSpec(doc);
  log.info('discover', `spec "${parsed.title}" v${parsed.version}: ${parsed.endpoints.length} GET endpoint(s), hash ${specHash.slice(0, 12)}`);

  let [tool] = await db.select().from(schema.tools).where(eq(schema.tools.name, target.name));
  if (!tool) {
    [tool] = await db.insert(schema.tools).values({ name: target.name, kind: 'rest_api', category: target.category ?? null }).returning();
    log.info('discover', `created tool #${tool.id} ${tool.name}`);
  }

  let [version] = await db
    .select()
    .from(schema.toolVersions)
    .where(and(eq(schema.toolVersions.toolId, tool.id), eq(schema.toolVersions.specHash, specHash)));
  let isNewVersion = false;
  if (!version) {
    // Hash the full document (any upstream change = new version); store only the paths we use.
    const blob = target.include_paths?.length ? trimSpec(doc, target.include_paths) : doc;
    [version] = await db
      .insert(schema.toolVersions)
      .values({ toolId: tool.id, versionLabel: parsed.version || null, specUrl: target.spec_url, specBlob: blob as object, specHash })
      .returning();
    isNewVersion = true;
    log.info('discover', `new tool_version #${version.id} (label "${parsed.version}")`);
  } else {
    log.info('discover', `spec unchanged; reusing tool_version #${version.id}`);
  }
  return { tool, version, parsed, isNewVersion };
}
