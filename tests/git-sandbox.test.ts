import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { GitFixture } from './helpers/git-fixture.js';
import { GitSandbox } from '../src/core/git-sandbox.js';
import { GitRunner } from '../src/core/git-runner.js';

describe('GitRunner and GitSandbox Isolation (Test 7 from RFC v3.0)', () => {
  let fixture: GitFixture;

  beforeEach(() => {
    fixture = new GitFixture();
  });

  afterEach(() => {
    fixture.dispose();
  });

  it('detects Git version >= 2.40 and native trees support', async () => {
    const runner = new GitRunner(fixture.dir);
    const version = await runner.getVersion();

    expect(version.major).toBeGreaterThanOrEqual(2);
    if (version.major === 2) {
      expect(version.minor).toBeGreaterThanOrEqual(40);
    }
    expect(version.mode).toBe('native-trees-2.45+');
  });

  it('verifies zero pollution of .git/objects and byte-for-byte preservation of .git/config', async () => {
    // 1. Initial commit on main
    fixture.commitFile('common.txt', 'base content\n', 'initial commit');

    // 2. Branch feature from main and add a file
    fixture.createBranch('feature');
    fixture.checkout('feature');
    fixture.commitFile('feature.txt', 'feature work\n', 'feature commit');
    const featureSha = fixture.getRevParse('feature');

    // 3. Go back to main and commit another file (so main and feature diverge)
    fixture.checkout('main');
    fixture.commitFile('main-only.txt', 'main work\n', 'divergent commit on main');
    const mainSha = fixture.getRevParse('main');

    // Record baseline state
    const initialConfig = fixture.readConfigFile();
    const initialObjectCount = fixture.countLooseObjects();

    // 4. Initialize Sandbox & Runner
    const sandbox = new GitSandbox({ repoDir: fixture.dir });
    const runner = new GitRunner(fixture.dir, sandbox);

    expect(fs.existsSync(sandbox.scratchObjDir)).toBe(true);

    // 5. Execute a 3-way merge-tree that must synthesize a brand new tree object
    const mergeResult = await runner.exec([
      'merge-tree',
      '--write-tree',
      mainSha,
      featureSha,
    ]);

    expect(mergeResult.exitCode).toBe(0);
    const resultTreeOid = mergeResult.stdout.trim();
    expect(resultTreeOid).toMatch(/^[0-9a-f]{40}$/);

    // 6. Verify Isolation:
    // a) .git/config must be byte-for-byte identical
    const currentConfig = fixture.readConfigFile();
    expect(currentConfig).toBe(initialConfig);

    // b) .git/objects must NOT have any new loose objects
    const currentObjectCount = fixture.countLooseObjects();
    expect(currentObjectCount).toBe(initialObjectCount);

    // c) New objects were written into the sandbox scratch directory
    const scratchEntries = fs.readdirSync(sandbox.scratchObjDir);
    expect(scratchEntries.length).toBeGreaterThan(0);

    // 6. Dispose sandbox and verify scratch directory is cleaned up
    sandbox.dispose();
    expect(fs.existsSync(sandbox.scratchObjDir)).toBe(false);
  });
});
