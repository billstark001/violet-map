import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { waitForProcessOutput } from '../acceptance/helpers/process-startup.ts';

function child(t, script) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => process.kill('SIGTERM'));
  return process;
}

test('process startup joins split ANSI/port output and releases listeners on success', async (t) => {
  const process = child(
    t,
    "process.stdout.write('http://127.0.0.1:\\x1b[3'); setTimeout(() => process.stdout.write('2m12'), 10); setTimeout(() => process.stdout.write('345/\\x1b[0m\\n'), 25); setInterval(() => {}, 1000);",
  );
  const result = await waitForProcessOutput(process, /http:\/\/127\.0\.0\.1:\d+(?=\/|\s)/, 'fixture');
  assert.equal(result[0], 'http://127.0.0.1:12345');
  assert.equal(process.stdout.listenerCount('data'), 0);
  assert.equal(process.listenerCount('exit'), 0);
});

test('process startup exit errors retain bounded diagnostics and release listeners', async (t) => {
  const process = child(t, "process.stderr.write('x'.repeat(70000) + '\\nstartup failed'); process.exitCode = 3;");
  await assert.rejects(waitForProcessOutput(process, /never-ready/, 'fixture'), (error) => {
    assert.match(error.message, /fixture exited 3/);
    assert.match(error.message, /startup failed/);
    assert.ok(error.message.length < 66000);
    return true;
  });
  assert.equal(process.stdout.listenerCount('data'), 0);
});

test('process startup timeout is bounded and does not retain readiness listeners', async (t) => {
  const process = child(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(waitForProcessOutput(process, /never-ready/, 'fixture', 50), /fixture startup timed out/);
  assert.equal(process.stdout.listenerCount('data'), 0);
  assert.equal(process.listenerCount('error'), 0);
});
