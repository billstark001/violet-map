import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResourceError, ResourceError } from '../src/resources.js';

test('resource error documents preserve known codes and require complete current metadata', () => {
  const error = parseResourceError({ code: 'RESOURCE_BUSY', message: 'work admission is busy', retryable: true });
  assert.ok(error instanceof ResourceError);
  assert.equal(error.code, 'RESOURCE_BUSY');
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'work admission is busy');
  for (const invalid of [
    null,
    [],
    {},
    { code: 'RESOURCE_BUSY' },
    { code: 'OLD_RESOURCE_ERROR', message: 'old', retryable: true },
    { code: 'RESOURCE_BUSY', message: 'busy', retryable: 'true' },
    { code: 'RESOURCE_BUSY', message: {}, retryable: true },
    { code: 'RESOURCE_BUSY', message: 'busy', retryable: true, oldMessage: 'old' },
  ])
    assert.throws(() => parseResourceError(invalid), TypeError);
});
