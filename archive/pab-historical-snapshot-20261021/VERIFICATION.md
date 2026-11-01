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

## Bounded file-RPC evidence correction

Full local suite: **105 passed, 0 failed, 0 skipped** (68.67 seconds).
`git diff --check` passed. Nine added regressions cover real sandboxed file edits,
ordered concurrent requests, outside-write denial, copy/remove and unsupported
rename rejection, payload/secret exclusion, record limits, incomplete/conflicting
capture, persistence failure before dispatch, cleanup/restart retention, and
preserved simulated review PASS/FAIL results. An observed outside read prohibited
by an explicit fixture contract retains FAIL despite otherwise complete capture.

Reviewer-instruction assertions distinguish broad-read capability from actual
prohibited reads and retain missing-evidence failures. Model verdicts are simulated;
no new Agents API review or implementation was run. Kernel/RPC execution is real
and local. Tests use disposable fixtures only.

Before/after fingerprints of the preserved failure fixture's task record, audit
records and full workspace (including the frozen review packet) match. No bridge
restart or publication occurred. Activation requires a safe bridge restart. Legacy
tasks without first-executor RPC capture remain incomplete; their historical
operations cannot be reconstructed or retroactively certified.


## Review-packet budgeting correction

Full local suite: **111 passed, 0 failed, 0 skipped** (78.07 seconds).
`git diff --check` passed. Six added regression tests cover a moderately large
repository file with complete file-RPC evidence, independent stream truncation,
deterministic semantic-preserving diff deduplication, non-deduplicable patch overflow,
required results after inspection quota exhaustion, relevant Git-operation priority,
and required-section overflow with diagnostics through MCP and `get_task` before
reviewer creation. Existing review/sandbox/publication tests were not modified.

A read-only reconstruction of the preserved sizing failure measured 156,875 bytes
with the prior serializer; compact JSON alone was still 138,807 bytes. The corrected
builder produced 130,693 bytes, including full baseline/current text and diff. These
are reconstructed measurements using current read-only controller observations; a
same-length tree-SHA placeholder avoided writing any Git objects. The task was not
reviewed or resumed. Its pre-existing RPC omission counter remains incomplete and
was not retroactively repaired or converted to PASS.

The first full run caught an oversized-file error-code compatibility change;
that code was preserved and the full suite rerun successfully. No real Agents API
task, bridge restart or publication was performed. Preserved task/workspace/evidence
and audit fingerprints were unchanged. Activation requires a safe controller restart.
