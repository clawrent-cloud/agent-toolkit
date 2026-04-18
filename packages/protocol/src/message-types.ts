export const MessageType = {
  // Session control
  SESSION_INIT: 'session.init',
  SESSION_READY: 'session.ready',
  SESSION_PAUSE: 'session.pause',
  SESSION_RESUME: 'session.resume',
  SESSION_COMPLETE: 'session.complete',
  SESSION_ABORT: 'session.abort',
  SESSION_CHECKPOINT: 'session.checkpoint',

  // Structured instructions (Provider → Consumer)
  INSTRUCTION_EXEC: 'instruction.exec',
  INSTRUCTION_READ_FILE: 'instruction.read_file',
  INSTRUCTION_WRITE_FILE: 'instruction.write_file',
  INSTRUCTION_READ_DIR: 'instruction.read_dir',
  INSTRUCTION_HTTP: 'instruction.http',
  INSTRUCTION_BATCH: 'instruction.batch',

  // Instruction results (Consumer → Provider)
  RESULT_SUCCESS: 'result.success',
  RESULT_ERROR: 'result.error',
  RESULT_PERMISSION_DENIED: 'result.permission_denied',
  RESULT_TIMEOUT: 'result.timeout',

  // Natural language dialogue (bidirectional)
  DIALOGUE_MESSAGE: 'dialogue.message',
  DIALOGUE_QUESTION: 'dialogue.question',
  DIALOGUE_TASK_UPDATE: 'dialogue.task_update',

  // System messages (Platform → Both)
  SYSTEM_PERMISSION_CHECK: 'system.permission_check',
  SYSTEM_RATE_LIMIT: 'system.rate_limit',
  SYSTEM_WARNING: 'system.warning',
  SYSTEM_BILLING_UPDATE: 'system.billing_update',

  // Staff messages (Platform ↔ Agent Staff)
  STAFF_TASK_ASSIGN: 'staff.task_assign',
  STAFF_TASK_RESULT: 'staff.task_result',
  STAFF_QUERY: 'staff.query',
  STAFF_QUERY_RESPONSE: 'staff.query_response',
  STAFF_ACTION_PROPOSAL: 'staff.action_proposal',
  STAFF_ACTION_APPROVED: 'staff.action_approved',
  STAFF_ACTION_REJECTED: 'staff.action_rejected',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];
