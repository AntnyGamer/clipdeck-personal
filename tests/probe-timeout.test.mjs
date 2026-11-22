import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { run } from '../media.mjs';

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

test('subprocess timeouts show tool-appropriate errors', async () => {
  const command = ['-e', 'setTimeout(() => {}, 10000)'];
  await assert.rejects(run(process.execPath, command, {}, { timeout: 50 }),
    /media tool took too long/i);
  await assert.rejects(run(process.execPath, command, {}, {
    timeout: 50, timeoutMessage: 'YouTube took too long to respond. Try the link again.',
  }), /YouTube took too long/);
});
