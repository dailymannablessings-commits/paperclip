import { describe, expect, it, vi } from "vitest";

const {
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports matches without leaking tokens or matched source contents", () => {
    const spawn = vi.fn().mockReturnValueOnce({status:0,signal:null}).mockReturnValueOnce({status:1,signal:null});
    const log=vi.fn(),error=vi.fn();
    expect(runForbiddenTokenCheck({repoRoot:"/repo",tokens:["synthetic-private-token","custom-token"],spawn,log,error})).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("Build blocked: forbidden tokens were detected in tracked files. Matched contents are withheld.");
    expect(JSON.stringify([...log.mock.calls,...error.mock.calls])).not.toContain("synthetic-private-token");
  });

});

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function fixtureRepo(content = 'public fixture\n') {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-token-scan-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'fixture.txt'), content);
  execFileSync('git', ['add', 'fixture.txt'], { cwd: root });
  return root;
}
function check(repoRoot: string, tokens: string[], overrides = {}) {
  return runForbiddenTokenCheck({ repoRoot, tokens, log: vi.fn(), error: vi.fn(), ...overrides });
}

describe('packaging token scan safety regressions', () => {
  it('blocks a real match set larger than the old execSync buffer', () => {
    const root = fixtureRepo('synthetic-private-needle\n'.repeat(100_000));
    try { expect(check(root, ['synthetic-private-needle'])).toBe(1); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not execute shell substitutions supplied as a token', () => {
    const token = '$(touch owned-sentinel)';
    const root = fixtureRepo(token + '\n');
    try {
      expect(check(root, [token])).toBe(1);
      expect(existsSync(join(root, 'owned-sentinel'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('matches literal configured tokens rather than regular expressions', () => {
    const root = fixtureRepo('ab\n');
    try { expect(check(root, ['a[b]'])).toBe(0); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    { status: 2, signal: null, error: undefined },
    { status: null, signal: 'SIGTERM', error: undefined },
    { status: null, signal: null, error: Object.assign(new Error('synthetic-private-error'), {code:'ENOBUFS'}) },
  ])('fails closed on an incomplete scan without printing token or error details %j', result => {
    const root = fixtureRepo(); const log = vi.fn(), error = vi.fn();
    try {
      expect(check(root, ['synthetic-private-needle'], { spawn: () => result, log, error })).toBe(1);
      expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('synthetic-private');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('filters only generic dynamic account values, preserving an explicit identical token', () => {
    const generic = { USER:'user', LOGNAME:'root', USERNAME:'runner' };
    const osModule = { userInfo: () => ({username:'nobody'}) };
    expect(resolveDynamicForbiddenTokens(generic, osModule)).toEqual([]);
    const root = fixtureRepo(); const tokensFile = join(root, 'configured-tokens.txt');
    writeFileSync(tokensFile, 'user\nrunner\n');
    try { expect(resolveForbiddenTokens(tokensFile, generic, osModule)).toEqual(['user', 'runner']); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['explicit-private-fixture','user','runner'])('checks explicit %s through the common hook list from an actual linked worktree', token => {
    const root = fixtureRepo(token+'\n'); const linked = root + '-linked';
    execFileSync('git', ['-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic fixture'], {cwd:root});
    mkdirSync(join(root,'.git','hooks'), {recursive:true});
    writeFileSync(join(root,'.git','hooks','forbidden-tokens.txt'),token+'\n');
    execFileSync('git',['worktree','add','-q','-b','fixture-linked',linked],{cwd:root});
    try {
      const script = resolve(process.cwd(), 'scripts/check-forbidden-tokens.mjs');
      const result = spawnSync(process.execPath,[script],{cwd:linked,env:{...process.env,USER:'user',LOGNAME:'user',USERNAME:'user'},encoding:'utf8'});
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(token);
    } finally { execFileSync('git',['worktree','remove',linked],{cwd:root});rmSync(root,{recursive:true,force:true}); }
  });
});


it('blocks an unavailable repository without leaking raw git diagnostics', () => {
  const root=mkdtempSync(join(tmpdir(),'synthetic-non-repo-'));
  try {
    const script=resolve(process.cwd(),'scripts/check-forbidden-tokens.mjs');
    const result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Build blocked: forbidden-token configuration or repository could not be read.');
  }finally{rmSync(root,{recursive:true,force:true})}
});
