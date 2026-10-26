#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check still uses the active local username when
 * available, except generic service/placeholder accounts. Explicit file tokens
 * are always checked. Git failures block publishing; matching contents stay private.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  // These ubiquitous service/placeholder accounts do not identify a person.
  // Filter only the inferred fallback, never the explicitly configured list.
  const genericAccounts = new Set(["user", "root", "runner", "nobody"]);
  return uniqueNonEmpty(candidates).filter((name) => !genericAccounts.has(name.toLowerCase()));
}

export function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

export function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  spawn = spawnSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  let found = false;

  for (const token of tokens) {
    let result;
    try {
      // Quiet literal matching avoids output-buffer false negatives and never
      // prints matched secrets. An argument array prevents shell expansion.
      result = spawn("git", ["grep", "-F", "-i", "-q", "-e", token, "--", ":!pnpm-lock.yaml", ":!.git"], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 30_000,
      });
    } catch {
      error("Build blocked: forbidden-token scan could not complete.");
      return 1;
    }
    if (result.error || result.signal || ![0, 1].includes(result.status)) {
      error("Build blocked: forbidden-token scan could not complete.");
      return 1;
    }
    if (result.status === 0) found = true;
  }

  if (found) {
    error("Build blocked: forbidden tokens were detected in tracked files. Matched contents are withheld.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

function resolveRepoPaths() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, commonDir, "hooks/forbidden-tokens.txt"),
  };
}

function main() {
  try {
    const { repoRoot, tokensFile } = resolveRepoPaths();
    const tokens = resolveForbiddenTokens(tokensFile);
    process.exit(runForbiddenTokenCheck({ repoRoot, tokens }));
  } catch {
    console.error("Build blocked: forbidden-token configuration or repository could not be read.");
    process.exit(1);
  }
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
