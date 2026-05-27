// Typed HTTP client for the self-hosted MiroShark API (Track B / VPS).
//
// MiroShark is a black-box swarm-simulation service reached over the public
// internet (the orchestrator runs on Vercel, not the VPS — see §0/§2). Two env
// vars define the boundary: MIROSHARK_API_URL (public base) and
// MIROSHARK_API_TOKEN (bearer). Every request carries
// `Authorization: Bearer ${token}` and expects the `{ success, data }`
// envelope (§3, §5).
//
// The functions here are deliberately granular — one network call each — so
// the durable sim-run Inngest function can wrap every phase (and every poll
// tick) in its own step.run(), giving each its own Vercel invocation budget.
//
// NOTE (text-only contract, §3 / §4 step 6): our users type a sentence, there
// is no PDF. The authoritative §5 ontology endpoint takes a multipart `files`
// field, so we wrap the scenario as an in-memory `scenario.txt` and send it
// under `files` — that works against the *known* pipeline without depending on
// the still-unconfirmed raw-text field. If the VPS confirms a native text
// field (§9 deliverable #3), switch `generateOntology` to send it directly.

import { env } from '../env';
import type {
  GraphTaskStatus,
  MiroSharkEnvelope,
  OntologyResult,
  PrepareStatus,
  RunStatus,
  SimulationCreated,
  TaskAccepted,
} from './types';

/** Thrown on a non-2xx response or an envelope with `success: false`. */
export class MiroSharkError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'MiroSharkError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function baseUrl(): string {
  // Strip a trailing slash so `${base}/api/...` never doubles up.
  return env.MIROSHARK_API_URL.replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.MIROSHARK_API_TOKEN}` };
}

// Core fetch that unwraps the `{ success, data }` envelope. JSON bodies are
// stringified by the caller via `jsonBody`; multipart callers pass a FormData
// `body` directly (and we must NOT set content-type — fetch adds the boundary).
async function requestEnvelope<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = init;
  const res = await fetch(`${baseUrl()}${path}`, {
    ...rest,
    headers: { ...authHeaders(), ...(headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new MiroSharkError(
      `MiroShark ${path} → HTTP ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  let envelope: MiroSharkEnvelope<T>;
  try {
    envelope = JSON.parse(text) as MiroSharkEnvelope<T>;
  } catch {
    throw new MiroSharkError(
      `MiroShark ${path} → non-JSON response`,
      res.status,
      text.slice(0, 500),
    );
  }
  if (!envelope.success) {
    throw new MiroSharkError(
      `MiroShark ${path} → success:false (${envelope.error ?? envelope.message ?? 'no detail'})`,
      res.status,
      text.slice(0, 500),
    );
  }
  // `data` is present on success for every §5 endpoint we call.
  return (envelope.data ?? ({} as T)) as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ---- §5 step 1: Ontology ----------------------------------------------------

export interface GenerateOntologyArgs {
  scenario: string;
  projectName: string;
  /** What the sim should explore; defaults to the scenario sentence. */
  simulationRequirement?: string;
}

export async function generateOntology(
  args: GenerateOntologyArgs,
): Promise<OntologyResult> {
  const form = new FormData();
  // Wrap the user's sentence as a text file under the authoritative `files`
  // field (see header note on the text-only contract).
  form.append(
    'files',
    new Blob([args.scenario], { type: 'text/plain' }),
    'scenario.txt',
  );
  form.append('project_name', args.projectName);
  form.append(
    'simulation_requirement',
    args.simulationRequirement ?? args.scenario,
  );
  // Ontology generation runs an LLM pass — allow longer than the default.
  return requestEnvelope<OntologyResult>('/api/graph/ontology/generate', {
    method: 'POST',
    body: form,
    timeoutMs: 120_000,
  });
}

// ---- §5 step 2: Graph build (async) -----------------------------------------

export interface BuildGraphArgs {
  projectId: string;
  graphName: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export async function buildGraph(args: BuildGraphArgs): Promise<TaskAccepted> {
  return requestEnvelope<TaskAccepted>(
    '/api/graph/build',
    jsonBody({
      project_id: args.projectId,
      graph_name: args.graphName,
      chunk_size: args.chunkSize ?? 1024,
      chunk_overlap: args.chunkOverlap ?? 128,
    }),
  );
}

export async function getGraphTask(taskId: string): Promise<GraphTaskStatus> {
  return requestEnvelope<GraphTaskStatus>(
    `/api/graph/task/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
  );
}

// ---- §5 step 3: Create ------------------------------------------------------

export interface CreateSimulationArgs {
  projectId: string;
  enableTwitter?: boolean;
  enableReddit?: boolean;
  enablePolymarket?: boolean;
}

export async function createSimulation(
  args: CreateSimulationArgs,
): Promise<SimulationCreated> {
  return requestEnvelope<SimulationCreated>(
    '/api/simulation/create',
    jsonBody({
      project_id: args.projectId,
      enable_twitter: args.enableTwitter ?? true,
      enable_reddit: args.enableReddit ?? true,
      enable_polymarket: args.enablePolymarket ?? true,
    }),
  );
}

// ---- §5 step 4: Prepare (async) ---------------------------------------------

export interface PrepareSimulationArgs {
  simulationId: string;
  useLlmForProfiles?: boolean;
  parallelProfileCount?: number;
}

export async function prepareSimulation(
  args: PrepareSimulationArgs,
): Promise<TaskAccepted> {
  return requestEnvelope<TaskAccepted>(
    '/api/simulation/prepare',
    jsonBody({
      simulation_id: args.simulationId,
      use_llm_for_profiles: args.useLlmForProfiles ?? true,
      parallel_profile_count: args.parallelProfileCount ?? 4,
    }),
  );
}

export async function getPrepareStatus(args: {
  taskId: string;
  simulationId: string;
}): Promise<PrepareStatus> {
  return requestEnvelope<PrepareStatus>(
    '/api/simulation/prepare/status',
    jsonBody({ task_id: args.taskId, simulation_id: args.simulationId }),
  );
}

// ---- §5 step 5: Run (async) -------------------------------------------------

export interface StartSimulationArgs {
  simulationId: string;
  maxRounds?: number;
  platform?: string;
  force?: boolean;
}

export async function startSimulation(
  args: StartSimulationArgs,
): Promise<unknown> {
  return requestEnvelope<unknown>(
    '/api/simulation/start',
    jsonBody({
      simulation_id: args.simulationId,
      platform: args.platform ?? 'parallel',
      max_rounds: args.maxRounds ?? 3,
      force: args.force ?? true,
    }),
  );
}

export async function getRunStatus(simulationId: string): Promise<RunStatus> {
  return requestEnvelope<RunStatus>(
    `/api/simulation/${encodeURIComponent(simulationId)}/run-status`,
    { method: 'GET' },
  );
}

// ---- Publish (REQUIRED for the share surfaces) ------------------------------
//
// VERIFIED against the repo (not in §5): signal.json, polymarket.json,
// share-card.png and a meaningful /watch ALL require `is_public=true` — a
// private sim returns 404 / a bare frame. So we must publish before fetching
// results or handing the user any link. The e2e script never publishes (it
// only exercises the report path), which is why the spec missed this.
//
// Auth: the publish/resolve/outcome mutation routes require
// `Authorization: Bearer $MIROSHARK_ADMIN_TOKEN` (a fail-closed admin secret,
// 503 if unset). We send the standard MIROSHARK_API_TOKEN, so the VPS must set
// MIROSHARK_ADMIN_TOKEN equal to the proxy bearer for this to pass both the
// proxy and MiroShark's own check. See §9 follow-up.
export async function publishSimulation(
  simulationId: string,
  isPublic = true,
): Promise<{ simulation_id: string; is_public: boolean }> {
  return requestEnvelope<{ simulation_id: string; is_public: boolean }>(
    `/api/simulation/${encodeURIComponent(simulationId)}/publish`,
    jsonBody({ public: isPublic }),
  );
}

// ---- §5 step 7: Results -----------------------------------------------------
//
// The result-file endpoints return raw JSON (not the envelope), so they bypass
// requestEnvelope. share-card.png and /watch are not fetched server-side — we
// just hand their URLs to the user (the share card renders inline, /watch is a
// live page).

async function fetchRawJson(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new MiroSharkError(
      `MiroShark ${path} → HTTP ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MiroSharkError(
      `MiroShark ${path} → non-JSON response`,
      res.status,
      text.slice(0, 500),
    );
  }
}

export function getSignal(simulationId: string): Promise<unknown> {
  return fetchRawJson(
    `/api/simulation/${encodeURIComponent(simulationId)}/signal.json`,
  );
}

export function getPolymarket(simulationId: string): Promise<unknown> {
  return fetchRawJson(
    `/api/simulation/${encodeURIComponent(simulationId)}/polymarket.json`,
  );
}

/** Public URL of the share card PNG (rendered inline in chat/web). */
export function shareCardUrl(simulationId: string): string {
  return `${baseUrl()}/api/simulation/${encodeURIComponent(simulationId)}/share-card.png`;
}

/** Public URL of MiroShark's own live "watch this sim" page. */
export function watchUrl(simulationId: string): string {
  return `${baseUrl()}/watch/${encodeURIComponent(simulationId)}`;
}
