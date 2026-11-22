import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('file inspection has no fixed timeout locally but is bounded when hosted', () => {
  const fileUrl = new URL('../media.mjs', import.meta.url).href;
  const script = `import { fileProbeTimeout } from ${JSON.stringify(fileUrl)};
process.stdout.write(String(fileProbeTimeout));`;

  for (const [hosted, expected] of [['0', 0], ['1', 20000]]) {
    const timeout = Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CLIPDECK_HOSTED: hosted },
    }));
    assert.equal(timeout, expected, `CLIPDECK_HOSTED=${hosted}`);
  }
});
