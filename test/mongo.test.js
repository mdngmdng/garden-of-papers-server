const test = require('node:test');
const assert = require('node:assert/strict');
const { projectDatabaseName } = require('../src/services/mongo');

test('keeps existing valid project database names unchanged', () => {
  assert.equal(projectDatabaseName('08-13 FullPaperSurvey'), '08-13 FullPaperSurvey');
  assert.equal(projectDatabaseName(undefined), undefined);
});

test('maps project names with MongoDB-forbidden characters to a stable database name', () => {
  const name = '08/13 FullPaperSurvey(TVCG,CHI,UIST)';
  const first = projectDatabaseName(name);
  assert.match(first, /^gop_project_[a-f0-9]{32}$/u);
  assert.equal(projectDatabaseName(name), first);
  assert.notEqual(first, projectDatabaseName('08:13 FullPaperSurvey(TVCG,CHI,UIST)'));
});
