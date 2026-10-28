#!/usr/bin/env node
// Explicit release-operator boundary, not the ordinary developer test command.
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MANIFESTS = ['package.json', 'cli/package.json', 'cli/README.md', 'packages/skills-catalog/generated/catalog.json'];
const PHASES = { 'full-tests': ['test:run'], typecheck: ['-r', 'typecheck'], build: ['build'] };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function git(root, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error('Reviewed source Git evidence unavailable');
  return result.stdout;
}

function directoryChain(path) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Evidence/source parent must be an existing nonsymlink directory');
  }
  return absolute;
}

function ownedFile(path, initial) {
  directoryChain(dirname(path));
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(fd);
  let lastHash;
  const contentHash = () => {
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let offset = 0;
    while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) throw new Error('Owned evidence truncated'); offset += read; }
    return digest(bytes);
  };
  const matches = () => {
    try { const current = lstatSync(path); return !current.isSymbolicLink() && current.isFile() && sameFile(current, identity) && (lastHash === undefined || contentHash() === lastHash); } catch { return false; }
  };
  const write = (value) => {
    if (!matches()) throw new Error('Owned evidence path changed; foreign replacement preserved');
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
    lastHash = digest(bytes);
    if (!matches()) throw new Error('Owned evidence path changed during write');
  };
  try { write(initial); } catch (error) { closeSync(fd); throw error; }
  return { write, close: () => closeSync(fd), remove: () => { if (!matches()) throw new Error('Owned lock changed; foreign replacement preserved'); unlinkSync(path); } };
}

function sourceState(root, expectedHead) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  if (head !== expectedHead) throw new Error('Reviewed HEAD changed');
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('Source is not the reviewed development tree; publication outputs or concurrent edits must be dispositioned by their owner');
  const algorithm = git(root, ['rev-parse', '--show-object-format']).trim();
  if (!['sha1', 'sha256'].includes(algorithm)) throw new Error('Unsupported Git object format');
  const entries = git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean);
  const observed = new Map();
  const parents = new Set();
  for (const entry of entries) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Unsupported tracked source entry');
    const [, mode, expected, name] = match;
    const file = resolve(root, name);
    if (relative(root, file).startsWith('..' + sep) || file === root) throw new Error('Tracked source path escapes worktree');
    const parent = dirname(file);
    if (!parents.has(parent)) { directoryChain(parent); parents.add(parent); }
    const before = lstatSync(file);
    let content;
    if (mode === '120000') {
      if (!before.isSymbolicLink()) throw new Error('Tracked source link changed');
      content = Buffer.from(readlinkSync(file));
    } else {
      if (!before.isFile() || before.isSymbolicLink() || Boolean(before.mode & 0o111) !== (mode === '100755')) throw new Error('Tracked source type or executable mode changed');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameFile(before, fstatSync(fd))) throw new Error('Tracked source changed during inspection');
        content = readFileSync(fd);
        const after = fstatSync(fd);
        if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Tracked source changed during inspection');
      } finally { closeSync(fd); }
    }
    const blob = createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
    if (blob !== expected) throw new Error('Materialized source differs from reviewed Git objects, including hidden index flags');
    observed.set(name, digest(content));
  }
  for (const name of MANIFESTS) if (!observed.has(name)) throw new Error('Reviewed development manifest is missing');
  return { head, tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(), trackedFiles: entries.length, manifests: Object.fromEntries(MANIFESTS.map((name) => [name, observed.get(name)])) };
}

function options(argv) {
  const boundary = argv.indexOf('--');
  if (boundary < 0) throw new Error('Use --phase PHASE --expected-head SHA --receipt OUTSIDE_WORKTREE -- pnpm PHASE_COMMAND');
  const flags = {};
  for (let index = 0; index < boundary; index += 2) {
    const name = argv[index];
    if (!['--repo', '--phase', '--expected-head', '--receipt'].includes(name) || !argv[index + 1] || flags[name]) throw new Error('Invalid operator guard arguments');
    flags[name] = argv[index + 1];
  }
  const command = argv.slice(boundary + 1);
  const phaseArgs = PHASES[flags['--phase']];
  if (!phaseArgs || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(flags['--expected-head'] ?? '') || !flags['--receipt']) throw new Error('Exact reviewed HEAD, supported phase and private receipt are required');
  if (!['pnpm', 'pnpm.js', 'pnpm.cjs'].includes(basename(command[0] ?? '')) || JSON.stringify(command.slice(1)) !== JSON.stringify(phaseArgs)) throw new Error('Unsupported verification command; raw scripts, extra flags and secret-bearing arguments are not accepted');
  return { repo: flags['--repo'] ?? process.cwd(), phase: flags['--phase'], expected: flags['--expected-head'], receipt: resolve(flags['--receipt']), command };
}

export async function runReviewedVerification(argv) {
  const input = options(argv);
  const root = realpathSync(git(input.repo, ['rev-parse', '--show-toplevel']).trim());
  const receiptParent = directoryChain(dirname(input.receipt));
  if (receiptParent === root || !relative(root, input.receipt).startsWith('..' + sep)) throw new Error('Private evidence must be outside the reviewed worktree');
  const gitDir = realpathSync(git(root, ['rev-parse', '--absolute-git-dir']).trim());
  // --absolute-git-dir is worktree-specific, not the shared common directory.
  const lockPath = join(gitDir, 'reviewed-verification.lock');
  const identity = { schema: 1, runId: randomUUID(), phase: input.phase, expectedHead: input.expected, worktree: root, commandSha256: digest(JSON.stringify(input.command)), startedAt: new Date().toISOString() };
  let lock, receipt, child, signal;
  let verdict = { ...identity, status: 'incomplete', childExitCode: null, sourceBefore: null, sourceAfter: null };
  const forward = (name) => { signal ??= name; if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, name); } catch {} } };
  const onTerm = () => forward('SIGTERM'), onInt = () => forward('SIGINT');
  try {
    lock = ownedFile(lockPath, identity);
    receipt = ownedFile(input.receipt, verdict);
    verdict.sourceBefore = sourceState(root, input.expected);
    receipt.write(verdict);
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    const result = await new Promise((resolveChild) => {
      child = spawn(input.command[0], input.command.slice(1), { cwd: root, stdio: 'inherit', detached: true });
      child.once('error', () => resolveChild({ code: null, signal: 'spawn_error' }));
      child.once('close', (code, name) => resolveChild({ code, signal: name }));
    });
    verdict.childExitCode = result.code;
    if (signal || result.signal) { verdict.signal = signal ?? result.signal; verdict.status = 'incomplete'; }
    else {
      verdict.sourceAfter = sourceState(root, input.expected);
      verdict.status = result.code === 0 ? 'source_guard_passed_command_exit_zero' : 'command_failed';
    }
  } catch (error) {
    verdict.status = 'guard_failed';
    // Never include raw argv, environment values, Git output or child errors.
    verdict.error = error.code === 'EEXIST' ? 'Evidence/lock collision; existing path preserved' : error.message;
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    verdict.finishedAt = new Date().toISOString();
    try { lock?.remove(); } catch { verdict.status = 'guard_failed'; verdict.error = 'Owned lock changed; foreign replacement preserved'; }
    lock?.close();
    try { receipt?.write(verdict); } catch { verdict.status = 'guard_failed'; }
    receipt?.close();
  }
  return verdict.status === 'source_guard_passed_command_exit_zero' ? 0 : verdict.status === 'incomplete' ? 130 : 1;
}

if (isAbsolute(process.argv[1] ?? '') && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  runReviewedVerification(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { console.error('Reviewed verification guard refused admission'); process.exitCode = 1; });
}
