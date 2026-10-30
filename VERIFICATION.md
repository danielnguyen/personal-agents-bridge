# Verification

## Local regression suite

Run `npm test` on a Linux host that supports the required Codex namespace/sandbox
mechanisms. These tests use fake Agents API sessions; they do not start paid model
turns. Kernel tests use real local processes/listeners. Publication tests push only
to temporary local bare repositories and mock GitHub PR operations.

The suite covers:

- Task lifecycle, clarification, independent review, cleanup and bounded diagnostics.
- Registry validation, bridge-self-target rejection, pinned baseline worktrees,
  concurrent isolation and unchanged normal checkouts (initially clean or dirty).
- Controller evidence, scope checks, packet bounds/redaction and startup attestation.
- Permitted worktree writes, denied outside creation/truncation, protected checkout
  and Git metadata, network denial, explicit-URL push denial and file-RPC boundaries.
- Exact-tree publication for one/multiple files, deletes, renames, executable modes,
  symlinks and binary content; missing/failed/stale review and tree mismatch rejection.
- Remote branch conflicts/races, default-branch rejection, freezing, concurrency,
  lost-response reconciliation, strict MCP schema and durable publication audit.
- Ordered file-RPC journals, payload exclusion, record limits, missing/conflicting
  capture, persistence failure before dispatch, and cleanup/restart retention.
- Deterministic packet budgeting, independent stream truncation, complete semantic
  file maps, required test retention, Git-operation priority and overflow diagnostics.
- Contract generation and reviewer instructions that distinguish proven structural
  boundaries from task-specific behavioral restrictions and optional history.

## Limits and operational compatibility

Local tests do not prove current ChatGPT discovery, account authorization, model
behavior, or live GitHub PR creation. Those require separately authorized acceptance
runs. `npm run test:live` uses real paid sessions and is not part of the local suite.
Do not run it alongside a production controller. Reviewer regressions assert inputs
and preserve simulated verdicts; they do not establish live model behavior.

Activation requires a safe controller restart. Legacy tasks without first-executor
RPC capture remain incomplete; historical operations cannot be reconstructed or
retroactively certified. Old review packets without the frozen Git tree cannot be
retroactively authorized for publication. Existing frozen packets are not rewritten.
Version-5 packets now admit up to 64 MiB of retained review evidence by default.
The lower admission limit may be configured at controller startup using
`PAB_REVIEW_PACKET_LIMIT_BYTES` (integer bytes, 131072–67108864). The 64 MiB
hard retention bound remains in force for prior packets even if admission is
reduced later. Existing retained packets are not rewritten.

The reviewer reads only the controller-produced, frozen `evidence.json`, and
must inspect large source/evidence sections in bounded successive views rather
than loading them into one model response. Complete task-required evidence
remains mandatory; absence, corruption or unreviewed sections cannot PASS.
The independent-reviewer output cap remains 128 KiB, independent of evidence
capacity. Total packet bytes, per-record command limits and reviewer tokens are
distinct resource controls; raising the packet limit does not grant new execution,
network, publication or repository access.

## Public-source scan

Before publication, scan the proposed diff for credentials, private keys,
account/runtime IDs, UUIDs, personal paths and credential-bearing URLs/assignments.
Inspect every match: tests deliberately contain synthetic credential strings and
mock identifiers to verify rejection/redaction. A pattern scan cannot establish the
absence of every possible secret.

Runtime databases, registry contents, tunnel configuration, reports and investigation
artifacts belong outside the public source repository. `.gitignore` protects these
if accidentally copied into it. Publish only reviewed source, tests and public
documentation, with history based on the public repository.
