import test from 'node:test';
import assert from 'node:assert/strict';
import { statusReport } from '../lib/core.mjs';

function report(lastRun) {
  const state = { lastRun, slots: {}, accounts: {} };
  const before = JSON.stringify(state);
  const result = statusReport(10, {
    loadState: () => state,
    loadConfig: () => ({ model: 'codex/fixture', gatewayKey: 'fixture-secret', slots: [0,8,16] }),
    readLock: () => ({ running: false }),
    stateDir: () => '/fixture', recentRuns: () => [],
  });
  assert.equal(JSON.stringify(state), before, 'display conversion must not rewrite old records');
  return result;
}

test('legacy completed outcomes supply known totals instead of falsely reporting no accounts', () => {
  for (const progress of [undefined, {}, { phase: 'done', completedAccounts: 0 }]) {
    const result = report({ status: 'done', accounts: [{ verdict:'ok' }, { verdict:'ok' }], progress });
    assert.equal(result.progress.total, 2);
    assert.equal(result.progress.completed, 2);
    assert.equal(result.lastRun.accounts.length, 2);
    assert.equal(result.running, false);
  }
});

test('an actually empty legacy run remains empty', () => {
  const result = report({ status:'done', accounts:[] });
  assert.equal(result.progress.total, 0);
  assert.equal(result.progress.completed, 0);
});

test('explicit counters in modern runs remain authoritative', () => {
  const result = report({ status:'done', accounts:[{verdict:'ok'}], progress:{totalAccounts:3,completedAccounts:3} });
  assert.equal(result.progress.total, 3);
  assert.equal(result.progress.completed, 3);
});
