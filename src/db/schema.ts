/**
 * Autopia data model. Terms follow docs/compendium-spec.txt section 3.
 *
 *   TOOL -> TOOL_VERSION (fingerprinted by spec_hash)
 *     -> TEST_RUN (one pipeline execution)
 *        -> TRIAL (one HTTP call + logged result; cheap, no LLM)
 *        -> CLAIM (a behavioral statement + its evidence trial ids)
 *   CLAIM_DIFF links claims across two versions of the same tool.
 *
 * Claims belong to a test_run. "The current claims for a version" means
 * the claims of that version's latest finished run. Keeping every run's
 * claims lets us check determinism (run twice, same claim_keys).
 */
import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const tools = pgTable('tools', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull().default('rest_api'),
  category: text('category'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const toolVersions = pgTable(
  'tool_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    toolId: bigint('tool_id', { mode: 'number' })
      .notNull()
      .references(() => tools.id),
    versionLabel: text('version_label'),
    specUrl: text('spec_url').notNull(),
    specBlob: jsonb('spec_blob').notNull(),
    specHash: text('spec_hash').notNull(),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tool_versions_tool_hash_idx').on(t.toolId, t.specHash)],
);

export const testRuns = pgTable('test_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  toolVersionId: bigint('tool_version_id', { mode: 'number' })
    .notNull()
    .references(() => toolVersions.id),
  batteryHash: text('battery_hash').notNull(),
  status: text('status').notNull().default('running'), // running | finished | failed
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  llmModel: text('llm_model'),
  llmInputTokens: integer('llm_input_tokens').notNull().default(0),
  llmOutputTokens: integer('llm_output_tokens').notNull().default(0),
  stats: jsonb('stats').notNull().default({}),
});

export const trials = pgTable(
  'trials',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    testRunId: bigint('test_run_id', { mode: 'number' })
      .notNull()
      .references(() => testRuns.id),
    endpoint: text('endpoint').notNull(), // e.g. "GET /v1/forecast"
    mutationType: text('mutation_type').notNull(), // battery kind, e.g. "wrong_type"
    mutationId: text('mutation_id').notNull(), // e.g. "wrong_type:past_days"
    paramName: text('param_name'),
    input: jsonb('input').notNull(), // the exact request (method, url, query pairs, headers)
    inputHash: text('input_hash').notNull(),
    response: jsonb('response').notNull(), // status, headers subset, body (truncated)
    signature: jsonb('signature').notNull(), // normalized shape used for reproduction
    statusCode: integer('status_code'),
    errorText: text('error_text'),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trials_run_idx').on(t.testRunId), index('trials_hash_idx').on(t.inputHash)],
);

export const claims = pgTable(
  'claims',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    toolVersionId: bigint('tool_version_id', { mode: 'number' })
      .notNull()
      .references(() => toolVersions.id),
    testRunId: bigint('test_run_id', { mode: 'number' })
      .notNull()
      .references(() => testRuns.id),
    claimKey: text('claim_key').notNull(), // stable identity across runs/versions
    statement: text('statement').notNull(),
    endpoint: text('endpoint').notNull(),
    kind: text('kind').notNull(), // required|type|auth|pagination|error_behavior|undocumented|other
    paramName: text('param_name'),
    verdict: text('verdict').notNull(), // accepts | rejects | observes
    source: text('source').notNull(), // rules | llm
    confidence: real('confidence').notNull(),
    divergenceType: text('divergence_type'), // spec | sibling | null  (spec wins when both apply)
    specSays: text('spec_says'),
    siblingNote: text('sibling_note'), // e.g. "open-meteo-forecast: accepts" when a sibling tool disagrees
    verified: boolean('verified').notNull().default(false),
    evidenceTrialIds: bigint('evidence_trial_ids', { mode: 'number' }).array().notNull(),
    expectations: jsonb('expectations').notNull(), // [{trial_id, status}] what each cited trial must show
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('claims_version_idx').on(t.toolVersionId),
    uniqueIndex('claims_run_key_idx').on(t.testRunId, t.claimKey),
  ],
);

export const claimDiffs = pgTable('claim_diffs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  toolId: bigint('tool_id', { mode: 'number' })
    .notNull()
    .references(() => tools.id),
  fromVersionId: bigint('from_version_id', { mode: 'number' })
    .notNull()
    .references(() => toolVersions.id),
  toVersionId: bigint('to_version_id', { mode: 'number' })
    .notNull()
    .references(() => toolVersions.id),
  claimKey: text('claim_key').notNull(),
  changeType: text('change_type').notNull(), // unchanged | changed | added | removed
  fromClaimId: bigint('from_claim_id', { mode: 'number' }),
  toClaimId: bigint('to_claim_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tool = typeof tools.$inferSelect;
export type ToolVersion = typeof toolVersions.$inferSelect;
export type TestRun = typeof testRuns.$inferSelect;
export type Trial = typeof trials.$inferSelect;
export type NewTrial = typeof trials.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimDiff = typeof claimDiffs.$inferSelect;
