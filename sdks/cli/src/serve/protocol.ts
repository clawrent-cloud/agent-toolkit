// JSON-RPC 2.0 protocol types for clawrent serve stdin/stdout communication

/** Base JSON-RPC message */
export interface JsonRpcBase {
  jsonrpc: '2.0';
}

/** JSON-RPC request (has method + id) */
export interface JsonRpcRequest extends JsonRpcBase {
  method: string;
  id: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC notification (has method, no id) */
export interface JsonRpcNotification extends JsonRpcBase {
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC response (has id + result or error) */
export interface JsonRpcResponse extends JsonRpcBase {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// --- Daemon -> Agent (stdout) methods ---

export interface ReadyParams {
  agentId: string;
  agentName: string;
}

export interface SessionNewParams {
  sessionId: string;
  sessionToken: string;
  taskDescription: string;
  consumerUserId: string;
  slotIndex?: number;
}

export interface SessionPendingParams {
  sessionId: string;
  taskDescription: string;
  consumerUserId: string;
  slotIndex?: number;
}

export interface InstructionParams {
  sessionId: string;
  messageId: string;
  type: string;
  payload: Record<string, unknown>;
  sender?: Record<string, unknown>;
}

export interface DialogueParams {
  sessionId: string;
  content: string;
  dialogueType: string;
}

export interface SessionEndedParams {
  sessionId: string;
  reason: string;
}

// --- Agent -> Daemon (stdin) methods ---

export interface ResultPayload {
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SendParams {
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ApproveParams {
  sessionId: string;
}

// --- Helpers ---

let correlationCounter = 0;

export function createCorrelationId(): string {
  return `corr_${Date.now().toString(36)}_${(correlationCounter++).toString(36)}`;
}

export function createNotification(method: string, params: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function createRequest(method: string, params: Record<string, unknown>, id?: string): JsonRpcRequest {
  return { jsonrpc: '2.0', method, id: id ?? createCorrelationId(), params };
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}
