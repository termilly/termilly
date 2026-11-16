// Tests for the GitHub words the Git window makes up (src/Termilly.Desktop/wwwroot/js/githubtext.js): an issue's branch,
// the issue a branch names, a pull request's draft, the issue filter and an issue's task details.
// Run with: node --test tests/js/githubtext.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueBranch, issueOfBranch, pullRequestDraft, filterIssues, issueDetails } from '../../src/Termilly.Desktop/wwwroot/js/githubtext.js';

test('an issue\'s branch: bugfix/ with its number and first words, feature/ for an enhancement', () => {
  assert.equal(issueBranch({ number: 72, title: 'remote-render-fix' }), 'bugfix/72-remote-render-fix');
  assert.equal(issueBranch({ number: 77, title: 'Links in **bold** or italic open with the asterisks!' }), 'bugfix/77-links-in-bold-or-italic');
  assert.equal(issueBranch({ number: 5, title: 'Dark mode', labels: [{ name: 'Enhancement' }] }), 'feature/5-dark-mode');
  assert.equal(issueBranch({ number: 9, title: '???' }), 'bugfix/9');
  assert.ok(issueBranch({ number: 1, title: 'a'.repeat(100) }).length <= 'bugfix/1-'.length + 40);
});

test('the issue a branch names', () => {
  assert.equal(issueOfBranch('bugfix/72-remote-render-fix'), 72);
  assert.equal(issueOfBranch('feature/38'), 38);
  assert.equal(issueOfBranch('12-quick'), 12);
  assert.equal(issueOfBranch('release/1.9.0'), null);
  assert.equal(issueOfBranch('main'), null);
  assert.equal(issueOfBranch(null), null);
});

test('a pull request starts with the issue\'s title and closes it; without one, the newest commit\'s subject', () => {
  assert.deepEqual(pullRequestDraft('bugfix/72-x', 'Fix it', { number: 72, title: 'remote-render-fix' }),
    { title: 'remote-render-fix (#72)', body: 'Closes #72' });
  assert.deepEqual(pullRequestDraft('bugfix/72-x', 'Fix it', null), { title: 'Fix it', body: 'Closes #72' });
  assert.deepEqual(pullRequestDraft('tidy-up', 'Tidy up', null), { title: 'Tidy up', body: '' });
});

test('the filter keeps issues by number, title, label or author', () => {
  const list = [
    { number: 72, title: 'remote-render-fix', author: 'alexunder18', labels: [{ name: 'bug' }] },
    { number: 9, title: 'WSL files panel', author: 'SebastianSosa', labels: [] },
  ];
  const numbers = filter => filterIssues(list, filter).map(i => i.number);
  assert.deepEqual(numbers(''), [72, 9]);
  assert.deepEqual(numbers('#72'), [72]);
  assert.deepEqual(numbers('wsl'), [9]);
  assert.deepEqual(numbers('BUG'), [72]);
  assert.deepEqual(numbers('sebastian'), [9]);
  assert.deepEqual(numbers('7'), []);
});

test('an issue\'s task details: its address, then its text, cut when long', () => {
  assert.equal(issueDetails({ url: 'https://github.com/o/r/issues/1', body: ' Steps\n- [ ] one ' }, 100), 'https://github.com/o/r/issues/1\nSteps\n- [ ] one');
  assert.equal(issueDetails({ url: 'u', body: '' }, 100), 'u');
  assert.equal(issueDetails({ url: 'u', body: 'abcdef' }, 3), 'u\nabc (the rest is on GitHub)');
});
