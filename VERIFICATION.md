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

Latest public-source preparation run: **96 passed, 0 failed, 0 skipped**
(56.81 seconds). `git diff --check` passed. The first sanitization run found one
fixture-byte expectation still using the previous sample; it was corrected before
the successful full rerun. No production enforcement code changed in this cleanup.

## Limits

Local tests do not prove current ChatGPT discovery, account authorization, model
behavior, or live GitHub PR creation. Those require separately authorized acceptance
runs. `npm run test:live` uses real paid sessions and is not part of the local suite.
Do not run it alongside a production controller. Old review packets without the
frozen Git tree cannot be retroactively authorized for publication.

## Public-source scan

The preparation audit scans intended source/untracked files and all available Git
blobs plus commit/tag objects. It checks credential patterns, exact available
credential values, private keys, account/runtime IDs, UUIDs, personal paths, and
credential-bearing URLs/assignments. Findings must be triaged: tests deliberately
contain synthetic credential strings and mock IDs to verify rejection/redaction.
A pattern scan cannot establish the absence of every possible secret.

Private operational identifiers were removed from public documentation. Existing
private history still contains earlier operational IDs and author metadata. It
must not be pushed unchanged; use a reviewed clean public snapshot or separately
approved history sanitization. No history rewrite or publication was performed.
Runtime databases, reports and investigation artifacts belong outside the source
repository and are excluded by `.gitignore` if accidentally copied into it.
