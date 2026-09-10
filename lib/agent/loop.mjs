// The bounded model loop. Written by the parent session in Track D once Tracks A to C land; this stub keeps the runtime importable.
// Contract: docs/AGENT_MODE_IMPLEMENTATION.md section 5.
export async function runLoop(handle){
  const error=new Error('Agent mode is not built into this Sidelook yet.');
  error.code='NOT_IMPLEMENTED';
  handle.emit();
  throw error;
}
