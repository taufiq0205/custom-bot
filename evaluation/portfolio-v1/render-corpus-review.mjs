import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(directory, 'cases.v1.json'), 'utf8'));
const inline = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const groups = values => (values ?? []).map(group => group.join(' / ')).join('; ');

function expected(testCase) {
  const value = testCase.expected;
  const parts = [`${value.route} / ${value.outcome}`];
  if (value.facts?.length) parts.push(`Facts: ${groups(value.facts)}`);
  if (value.forbiddenFacts?.length) parts.push(`Must not say: ${groups(value.forbiddenFacts)}`);
  if (value.retrieval) {
    const supporting = value.retrieval.supportingLabels?.join(', ') || 'none';
    parts.push(`Passages: ${supporting}`);
    if (value.retrieval.mustRetrieveLabels?.length) parts.push(`Must retrieve: ${value.retrieval.mustRetrieveLabels.join(', ')}`);
    if (value.retrieval.unsupported) parts.push(`No unsupported answer: ${value.retrieval.unsupported}`);
  }
  if (value.lookup) {
    const lookup = value.lookup;
    parts.push(`Lookup: ${lookup.mustRun ? 'required' : 'forbidden'}; return ${lookup.mustReturnOrderIds?.join(', ') || 'none'}; exclude ${lookup.mustNotReturnOrderIds?.join(', ') || 'none'}`);
  }
  if (value.memory) parts.push(`Memory: ${JSON.stringify(value.memory)}`);
  if (value.security) parts.push(`Security: ${JSON.stringify(value.security)}`);
  return parts.join('<br>');
}

const lines = [
  `# Portfolio evaluation corpus v${corpus.version}`,
  '',
  `Status: **${corpus.status}**. These are synthetic test prompts and expected outcomes for owner review; no customer/provider run or verdict is recorded here.`,
  '',
  `Counts: ${Object.entries(corpus.category_counts).map(([category, count]) => `${category} ${count}`).join(' · ')}. All prompts are English.`,
  '',
  'Review each prompt, expected behavior, and checklist. Corpus approval is recorded separately against the exact SHA-256. Human output verdicts and LLM judge results remain pending until a real run.',
  '',
  '| ID | Category | Synthetic customer message | Expected route, outcome and evidence | Human review checklist · result |',
  '|---|---|---|---|---|'
];

for (const testCase of corpus.cases) {
  const checklist = testCase.human_review.checklist.map(inline).join('<br>');
  lines.push(`| ${testCase.id} | ${testCase.category} | ${inline(testCase.message)} | ${expected(testCase)} | ${checklist}<br>Human: pending · LLM judge: pending |`);
}

lines.push('', 'Run `node evaluation/portfolio-v1/render-corpus-review.mjs` to regenerate this table from the case JSON.', '');
writeFileSync(join(directory, 'corpus-review.md'), lines.join('\n'));
const reviewTemplate = {
  runId: null,
  caseResultsSha256: null,
  reviews: corpus.cases.map(testCase => ({
    caseId: testCase.id,
    reviewer: null,
    verdict: 'pending',
    reason: null,
    checklist: testCase.human_review.checklist.map(item => ({ item, checked: null }))
  }))
};
writeFileSync(join(directory, 'human-reviews.template.json'), `${JSON.stringify(reviewTemplate, null, 2)}\n`);
