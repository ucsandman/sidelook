// Owns: the failure taxonomy the learning loop groups incidents by. docs/AGENT_SELF_HEALING.md section 3 is the
// source of truth; lib/agent/incidents.mjs (Track being built alongside this one) defines the same list for the
// runtime. This is a local copy, not an import, because incidents.mjs is not guaranteed to exist yet when this
// module is first used (see the lane brief). Cross-checked against lib/agent/incidents.mjs's own FAILURE_CLASSES
// once that file appeared in the tree during this build: identical, same order.
// Contract: docs/AGENT_LEARNING_LOOP.md section 8 (family reducer), docs/AGENT_SELF_HEALING.md section 3.

export const FAILURE_CLASSES = Object.freeze([
  'transient_provider', 'rate_limit', 'authentication_expired', 'timeout_before_request', 'timeout_during_request',
  'response_lost', 'provider_state_conflict', 'stale_entity_state', 'ambiguous_identity', 'malformed_model_output',
  'unsupported_tool_request', 'dashclaw_unavailable', 'dashclaw_block', 'approval_denied', 'approval_expired',
  'verification_mismatch', 'duplicate_effect_detected', 'renderer_interruption', 'local_process_interruption',
  'user_cancellation', 'unknown_external_state', 'model_transport_failure', 'precondition_refused'
]);
