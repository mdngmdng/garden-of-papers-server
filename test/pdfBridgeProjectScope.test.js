const assert = require('node:assert/strict');
const test = require('node:test');
const { pendingRequestId } = require('../src/services/pdfBridge');

test('uses a different pending document key for the same file in each project', () => {
  const projectA = pendingRequestId('board-a', 'shared-paper');
  const projectB = pendingRequestId('board-b', 'shared-paper');

  assert.notEqual(projectA, projectB);
});

test('pending document keys remain unambiguous when project names contain colons', () => {
  assert.notEqual(
    pendingRequestId('a:b', 'paper'),
    pendingRequestId('a', 'b:paper'),
  );
});
