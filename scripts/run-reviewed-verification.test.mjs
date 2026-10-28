import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const guard = fileURLToPath(new URL('./run-reviewed-verification.mjs', import.meta.url));
function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reviewed-phase-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo'), evidence = join(base, 'evidence');
  mkdirSync(repo); mkdirSync(evidence, { mode: 0o700 });
  for (const name of ['cli', 'packages/skills-catalog/generated']) mkdirSync(join(repo, name), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:run': 'fixture-only' } }));
  writeFileSync(join(repo, 'cli/package.json'), JSON.stringify({ private: true, dependencies: { '@paperclipai/server': 'workspace:*' } }));
  writeFileSync(join(repo, 'cli/README.md'), 'Development CLI\n');
  writeFileSync(join(repo, 'packages/skills-catalog/generated/catalog.json'), '{"generatedAt":"reviewed"}\n');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Synthetic verifier'); git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'reviewed development source');
  const head = git(repo, 'rev-parse', 'HEAD');
  const pnpm = join(base, 'pnpm');
  writeFileSync(pnpm, `#!/usr/bin/env node
const fs = require('node:fs'); const cp = require('node:child_process');
const e = process.env; const action = e.GUARD_FIXTURE_ACTION;
if (action === 'publication') fs.writeFileSync('cli/package.json', '{"dependencies":{"@paperclipai/server":"0.3.1"}}');
if (action === 'head') cp.execFileSync('git', ['-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','changed head']);
if (action === 'receipt') { fs.unlinkSync(e.GUARD_FIXTURE_RECEIPT); fs.symlinkSync(e.GUARD_FIXTURE_TARGET, e.GUARD_FIXTURE_RECEIPT); }
if (action === 'lock') { fs.unlinkSync(e.GUARD_FIXTURE_LOCK); fs.writeFileSync(e.GUARD_FIXTURE_LOCK, 'foreign lock replacement'); }
if (action === 'lock-content') fs.writeFileSync(e.GUARD_FIXTURE_LOCK, 'foreign same-inode lock');
fs.writeFileSync(e.GUARD_FIXTURE_MARKER, String(process.pid));
if (action === 'sleep') setInterval(() => {}, 1000);
else process.exit(action === 'failure' ? 7 : 0);
`); chmodSync(pnpm, 0o755);
  const marker = join(base, 'child-ran'), receipt = join(evidence, 'result.json');
  const lock = join(git(repo, 'rev-parse', '--absolute-git-dir'), 'reviewed-verification.lock');
  const args = (extra = {}) => [guard, '--repo', extra.repo ?? repo, '--phase', extra.phase ?? 'full-tests', '--expected-head', extra.head ?? head, '--receipt', extra.receipt ?? receipt, '--', pnpm, ...(extra.command ?? ['test:run'])];
  const env = (action = '') => ({ ...process.env, GUARD_FIXTURE_ACTION: action, GUARD_FIXTURE_MARKER: marker, GUARD_FIXTURE_RECEIPT: receipt, GUARD_FIXTURE_LOCK: lock });
  const run = (action = '', extra = {}, extraEnv = {}) => spawnSync(process.execPath, args(extra), { env: { ...env(action), ...extraEnv }, encoding: 'utf8', timeout: 15_000 });
  return { base, repo, evidence, head, pnpm, marker, receipt, lock, args, env, run, result: () => JSON.parse(readFileSync(receipt, 'utf8')) };
}

test('publication state is red until the operator restores only its verified outputs; artifacts survive', (t) => {
  const f = fixture(t);
  const artifact = join(f.evidence, 'published-cli.tgz'); writeFileSync(artifact, 'captured publication artifact');
  for (const name of ['cli/package.json', 'cli/README.md', 'packages/skills-catalog/generated/catalog.json']) writeFileSync(join(f.repo, name), 'publication output');
  assert.equal(f.run().status, 1); assert.equal(f.result().status, 'guard_failed'); assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(join(f.repo, 'cli/package.json'), 'utf8'), 'publication output');
  // Restoration is an explicit fixture-operator action, never guard behavior.
  git(f.repo, 'restore', '--source=HEAD', '--', 'cli/package.json', 'cli/README.md', 'packages/skills-catalog/generated/catalog.json');
  const next = join(f.evidence, 'after-restoration.json');
  assert.equal(f.run('', { receipt: next }).status, 0);
  const proof = JSON.parse(readFileSync(next, 'utf8'));
  assert.equal(proof.status, 'source_guard_passed_command_exit_zero'); assert.equal(proof.sourceBefore.head, f.head); assert.deepEqual(proof.sourceBefore, proof.sourceAfter);
  assert.equal(readFileSync(artifact, 'utf8'), 'captured publication artifact'); assert.equal(statSync(next).mode & 0o777, 0o600);
  assert.equal(existsSync(f.lock), false); assert.equal('command' in proof, false); assert.match(proof.commandSha256, /^[a-f0-9]{64}$/);
});

for (const action of ['publication', 'head']) test(`post-command ${action} drift cannot claim unchanged success`, (t) => {
  const f = fixture(t); assert.equal(f.run(action).status, 1); assert.equal(f.result().status, 'guard_failed'); assert.equal(f.result().childExitCode, 0); assert.equal(existsSync(f.marker), true);
});

test('foreign untracked edits are preserved and developer commands remain opt-in', (t) => {
  const f = fixture(t); writeFileSync(join(f.repo, 'foreign-notes.md'), 'uncommitted owner work');
  assert.equal(f.run().status, 1); assert.equal(existsSync(f.marker), false); assert.equal(readFileSync(join(f.repo, 'foreign-notes.md'), 'utf8'), 'uncommitted owner work');
  assert.equal(spawnSync(f.pnpm, ['test:run'], { cwd: f.repo, env: f.env(), encoding: 'utf8' }).status, 0);
  assert.equal(existsSync(f.marker), true);
});

test('hidden assume-unchanged publication metadata is rejected by actual object comparison', (t) => {
  const f = fixture(t); git(f.repo, 'update-index', '--assume-unchanged', 'cli/package.json');
  writeFileSync(join(f.repo, 'cli/package.json'), 'hidden publication state');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(f.run().status, 1); assert.equal(existsSync(f.marker), false); assert.equal(readFileSync(join(f.repo, 'cli/package.json'), 'utf8'), 'hidden publication state');
});

test('Git replacement objects cannot substitute publication source under the reviewed HEAD identity', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'cli/package.json'), '{"dependencies":{"@paperclipai/server":"0.3.1"}}');
  git(f.repo, 'add', 'cli/package.json'); git(f.repo, 'commit', '-qm', 'publication substitute');
  const substitute = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'update-ref', 'HEAD', f.head); git(f.repo, 'replace', f.head, substitute);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(f.run().status, 1); assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(join(f.repo, 'cli/package.json'), 'utf8'), '{"dependencies":{"@paperclipai/server":"0.3.1"}}');
});

test('wrong HEAD, unavailable Git evidence and missing manifests refuse execution', (t) => {
  const f = fixture(t); assert.equal(f.run('', { head: 'a'.repeat(40) }).status, 1); assert.equal(existsSync(f.marker), false);
  assert.equal(f.run('', { repo: f.evidence, receipt: join(f.evidence, 'not-git.json') }).status, 1);
  git(f.repo, 'rm', '-q', 'cli/README.md'); git(f.repo, 'commit', '-qm', 'missing manifest');
  assert.equal(f.run('', { head: git(f.repo, 'rev-parse', 'HEAD'), receipt: join(f.evidence, 'missing.json') }).status, 1); assert.equal(existsSync(f.marker), false);
});

test('receipt and lock collisions never overwrite or remove foreign files', (t) => {
  const f = fixture(t); writeFileSync(f.receipt, 'foreign receipt');
  assert.equal(f.run().status, 1); assert.equal(readFileSync(f.receipt, 'utf8'), 'foreign receipt'); assert.equal(existsSync(f.lock), false);
  writeFileSync(f.lock, 'foreign lock');
  assert.equal(f.run('', { receipt: join(f.evidence, 'collision.json') }).status, 1); assert.equal(readFileSync(f.lock, 'utf8'), 'foreign lock'); assert.equal(existsSync(f.marker), false);
});

test('symlink receipt and parent collisions preserve their targets', (t) => {
  const f = fixture(t); const target = join(f.evidence, 'foreign'); writeFileSync(target, 'preserve'); symlinkSync(target, f.receipt);
  assert.equal(f.run().status, 1); assert.equal(readFileSync(target, 'utf8'), 'preserve');
  const alias = join(f.base, 'evidence-alias'); symlinkSync(f.evidence, alias);
  assert.equal(f.run('', { receipt: join(alias, 'alias.json') }).status, 1); assert.equal(existsSync(join(f.evidence, 'alias.json')), false); assert.equal(existsSync(f.marker), false);
});

for (const action of ['lock', 'lock-content']) test(`foreign ${action} replacement is preserved and invalidates the final receipt`, (t) => {
  const f = fixture(t); assert.equal(f.run(action).status, 1); assert.match(readFileSync(f.lock, 'utf8'), /foreign/); assert.equal(f.result().status, 'guard_failed');
});

test('foreign receipt replacement is not followed or overwritten', (t) => {
  const f = fixture(t); const target = join(f.evidence, 'foreign-target'); writeFileSync(target, 'preserve');
  assert.equal(f.run('receipt', {}, { GUARD_FIXTURE_TARGET: target }).status, 1); assert.equal(readFileSync(target, 'utf8'), 'preserve'); assert.equal(readFileSync(f.receipt, 'utf8'), 'preserve');
});

test('only supported literal phase commands are accepted, without echoing secret arguments', (t) => {
  const f = fixture(t); const secret = 'fixture-secret-must-not-appear'; const result = f.run('', { command: ['test:run', '--token', secret] });
  assert.equal(result.status, 1); assert.equal((result.stdout + result.stderr).includes(secret), false); assert.equal(existsSync(f.marker), false); assert.equal(existsSync(f.receipt), false);
  assert.equal(f.run('', { phase: 'build', command: ['build'], receipt: join(f.evidence, 'build.json') }).status, 0);
});

test('command failure retains its actual exit without a success claim', (t) => {
  const f = fixture(t); assert.equal(f.run('failure').status, 1); assert.equal(f.result().status, 'command_failed'); assert.equal(f.result().childExitCode, 7);
});

test('an unavailable verification executable is red, not a completed or interrupted command', (t) => {
  const f = fixture(t); rmSync(f.pnpm);
  assert.equal(f.run().status, 1); assert.equal(f.result().status, 'guard_failed'); assert.equal(f.result().childExitCode, null); assert.equal(existsSync(f.marker), false);
});

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture child did not reach its owned signal boundary'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test('signals mark incomplete and independent Git worktrees do not share the phase lock', async (t) => {
  const f = fixture(t); const child = spawn(process.execPath, f.args(), { env: f.env('sleep'), stdio: 'ignore' });
  const finished = new Promise((resolve) => child.once('close', resolve));
  try {
    await waitUntil(() => existsSync(f.marker)); assert.equal(existsSync(f.lock), true);
    const other = join(f.base, 'other-worktree'); git(f.repo, 'worktree', 'add', '--detach', other, f.head);
    assert.equal(f.run('', { repo: other, receipt: join(f.evidence, 'other.json') }).status, 0);
    child.kill('SIGTERM'); assert.equal(await finished, 130); assert.equal(f.result().status, 'incomplete'); assert.equal(f.result().signal, 'SIGTERM'); assert.equal(existsSync(f.lock), false);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); await finished; }
});
