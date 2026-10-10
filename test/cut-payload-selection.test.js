import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('cut-payload selects exactly one complete payload tar, never the code-only tar', () => {
  const text = readFileSync(new URL('../.github/workflows/cut-payload.yml', import.meta.url), 'utf8');
  const body = text.split(/      - name: 取素材\(/)[1]?.split(/      - name: /)[0] || '';
  assert.match(body, /gh release download[^\n]+-p 'sp-client-payload-\*\.tar\.gz'/);
  assert.match(body, /archives=\("\$RUNNER_TEMP\/payload"\/sp-client-payload-\*\.tar\.gz\)/);
  assert.match(body, /test "\$\{#archives\[@\]\}" -eq 1/);
  assert.match(body, /tar="\$\{archives\[0\]\}"/);
  assert.doesNotMatch(body, /-p '\*\.tar\.gz'/);
});
