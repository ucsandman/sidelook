# Agent Learning Loop

Contract: `docs/AGENT_LEARNING_LOOP.md`. This is a short pointer; the docs lane expands it.

The offline loop over Agent mode's own evidence (runs, incidents, the eval report): freezes the current runtime as a
verifiable incumbent, reads and sanitizes evidence, turns repeated failures into regression scenarios, runs a
retrospective, proposes hypotheses, tries each as an isolated candidate in its own git worktree, evaluates it against
the incumbent and a held-out corpus, and rejects anything that weakens a safety invariant or touches governance
without a person. Nothing it does touches the production tree, a running run, or DashClaw policy.

## Commands

```
node agent-learning/learn.mjs [--dry-run] [--fixtures <dir>] [--data <dir>] [--max-candidates n]
                               [--model <id>] [--review-model <id>] [--out <dir>] [--promote <candidateId>] [--verify]
node agent-learning/regress.mjs --set dev|holdout|all [--root <tree>] [--json <path>]
```

- No flags: reads real evidence from `SIDELOOK_AGENT_DATA` (or the platform default), tries real model calls when one
  is configured, otherwise completes through memory and the report with no candidate invented.
- `--dry-run`: freeze, intake, reduce and the deterministic half of the retrospective only; nothing is written except
  the dry-run report; no worktree, no model call, no memory write.
- `--fixtures agent-learning/fixtures`: the end-to-end proof, real worktrees and real evaluation against canned
  model answers (`docs/AGENT_LEARNING_LOOP.md` section 13); add `--verify` to assert the three fixture scenarios
  from the written records and exit 1 on a mismatch.
- `--promote <candidateId>`: prepares the branch for a `promote_eligible`, reviewer-approved candidate and prints
  the merge command. It never merges, pushes, or touches `main`.

## Autonomous vs. needs a person

See `docs/AGENT_LEARNING_LOOP.md` section 14. In short: everything through comparing and reviewing a candidate runs
on its own; merging a branch, touching governed code, promoting a regression into `holdout`, and DashClaw/credential
changes are a person's call.
