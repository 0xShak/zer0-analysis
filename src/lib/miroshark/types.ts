// Wire types for the MiroShark API (miroshark-zero.html §5 — "authoritative,
// from test_e2e_api.py"). Every response is the envelope
// `{ success: boolean, data: {...} }`; the client unwraps `data` and throws on
// `success === false`. The result-file endpoints (signal.json, polymarket.json)
// return raw JSON and are typed loosely as `unknown`.

/** Standard MiroShark response envelope. */
export interface MiroSharkEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface OntologyResult {
  project_id: string;
  ontology: unknown;
}

export interface TaskAccepted {
  task_id: string;
}

/** GET /api/graph/task/{task_id} */
export interface GraphTaskStatus {
  // 'completed' | 'failed' | 'running' | 'pending' (string-typed to tolerate
  // server-side additions). On completion the graph_id is populated.
  status: string;
  graph_id?: string | null;
  error?: string | null;
}

export interface SimulationCreated {
  simulation_id: string;
}

/** POST /api/simulation/prepare/status */
export interface PrepareStatus {
  status: string; // 'completed' | 'running' | 'failed' | ...
  error?: string | null;
}

/** GET /api/simulation/{id}/run-status */
export interface RunStatus {
  // 'running' | 'completed' | 'idle' | 'stopped' | 'failed' (string-typed).
  runner_status: string;
  current_round?: number | null;
  max_rounds?: number | null;
}

/** Terminal runner states we treat as "the sim finished" (§5 step 5). */
export const RUNNER_DONE_STATES = ['completed', 'idle', 'stopped'] as const;
/** Runner states that mean the run failed outright. */
export const RUNNER_FAILED_STATES = ['failed', 'error'] as const;
