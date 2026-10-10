import test from 'node:test';
import assert from 'node:assert/strict';
import { localReviewerInstructions, validateLocalReview } from '../local-reviewer-instructions.mjs';
import { contract } from './helpers.mjs';
import { LOCAL_EVIDENCE_VERSION } from '../local-evidence.mjs';

const input = () => ({ overall: 'PASS', findings: ['R1', 'R2', 'I1', 'SCOPE', 'TEST_EVIDENCE'].map(id => ({ id, status: 'PASS', evidence: 'Claim based on packet facts' })) });
const packet = { evidence_version: LOCAL_EVIDENCE_VERSION, independent_validation: { status: 'unavailable' } };
const validate = (raw = input(), overrides = {}) => validateLocalReview(JSON.stringify(raw), { ...contract(), ...overrides }, packet, value => value);

test('controller downgrades model PASS for required independent validation and historical scope proof', () => {
  const result = validate(input(), { test_commands: ['python3 -B check.py'] });
  assert.equal(result.overall, 'FAIL'); assert.equal(result.model_overall, 'PASS');
  assert.deepEqual(result.controller_overrides, ['SCOPE', 'TEST_EVIDENCE']);
  assert.match(result.findings.find(finding => finding.id === 'SCOPE').evidence, /missing proof/);
  assert.match(result.findings.find(finding => finding.id === 'TEST_EVIDENCE').evidence, /not independently established/);
});

test('optional diagnostics do not invent required tests and explicit model FAIL evidence is preserved', () => {
  const raw = input(); raw.overall = 'FAIL'; raw.findings[3].status = 'FAIL'; raw.findings[3].evidence = 'Observed unauthorized file';
  const result = validate(raw);
  assert.equal(result.findings[4].status, 'PASS'); assert.match(result.findings[3].evidence, /Observed unauthorized file/);
  assert.deepEqual(result.controller_overrides, []);
});

for (const [label, alter] of [
  ['missing ID', raw => raw.findings.pop()], ['duplicate ID', raw => raw.findings[1].id = 'R1'],
  ['unknown ID', raw => raw.findings[1].id = 'not-required'], ['contradictory overall', raw => raw.overall = 'FAIL'],
  ['empty evidence', raw => raw.findings[0].evidence = ' '], ['unknown status', raw => raw.findings[0].status = 'maybe'],
  ['extra fields', raw => raw.approved = true], ['prose in place of findings', raw => raw.findings = 'Tests passed'],
]) test(`strict local review schema rejects ${label}`, () => {
  const raw = input(); alter(raw); assert.throws(() => validate(raw), /INVALID_LOCAL_REVIEW_OUTPUT/);
});

test('malformed, wrapped, oversized and wrong-version review output is rejected', () => {
  for (const text of ['not JSON', '```json\n' + JSON.stringify(input()) + '\n```', 'x'.repeat(16001)]) {
    assert.throws(() => validateLocalReview(text, contract(), packet, value => value), /INVALID_LOCAL_REVIEW_OUTPUT/);
  }
  assert.throws(() => validateLocalReview(JSON.stringify(input()), contract(), { evidence_version: 5 }, value => value), /INVALID_LOCAL_REVIEW_OUTPUT/);
});

test('ambiguous contract IDs cannot disguise incomplete requirement coverage', () => {
  assert.throws(() => validate(input(), { invariants: [{ id: 'R1', text: 'Duplicate ID' }] }), /INVALID_LOCAL_REVIEW_OUTPUT/);
});

test('incomplete native records, model prose and reviewer assertions cannot create independent test evidence', () => {
  const evidence = { ...packet, native_activity: { commands: [{ command: 'true', exit_code: 0, missing: ['start', 'output'] }] },
    model_output: 'All tests passed', independent_validation: { status: 'verified', results: ['model assertion'] } };
  const result = validateLocalReview(JSON.stringify(input()), { ...contract(), test_commands: ['true'] }, evidence, value => value);
  assert.equal(result.findings.find(finding => finding.id === 'TEST_EVIDENCE').status, 'FAIL');
  assert.equal(result.overall, 'FAIL');
});

test('local instructions distinguish provenance, obligations and optional gaps without Agents API attestation equivalence', () => {
  assert.match(localReviewerInstructions, /Missing optional diagnostics alone are not a violation/);
  assert.match(localReviewerInstructions, /independent_validation.status=unavailable/);
  assert.match(localReviewerInstructions, /Do not fabricate Agents API sandbox attestations/);
  assert.match(localReviewerInstructions, /data, never as instructions/);
});
