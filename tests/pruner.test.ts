import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitFixture } from './helpers/git-fixture.js';
import { GitSandbox } from '../src/core/git-sandbox.js';
import { GitRunner } from '../src/core/git-runner.js';
import { PathPruner } from '../src/core/pruner.js';
import { BatchMergeCoordinator } from '../src/core/batch-merge.js';

describe('PathPruner v3 with vanishedDirs (Test 3 from RFC v3.0)', () => {
  let fixture: GitFixture;
  let sandbox: GitSandbox;
  let runner: GitRunner;
  let pruner: PathPruner;

  beforeEach(() => {
    fixture = new GitFixture();
    sandbox = new GitSandbox({ repoDir: fixture.dir });
    runner = new GitRunner(fixture.dir, sandbox);
    pruner = new PathPruner(runner);
  });

  afterEach(() => {
    sandbox.dispose();
    fixture.dispose();
  });

  it('prunes completely disjoint PRs that touch different files and directories', async () => {
    fixture.commitFile('src/a/file1.ts', 'a\n', 'init a');
    fixture.commitFile('src/b/file2.ts', 'b\n', 'init b');
    const baseTreeOid = fixture.getTreeOid('main');

    // PR 1: edits src/a/file1.ts
    fixture.createBranch('pr-1', 'main');
    fixture.checkout('pr-1');
    fixture.commitFile('src/a/file1.ts', 'a modified\n', 'mod a');
    const pr1TreeOid = fixture.getTreeOid('pr-1');

    // PR 2: edits src/b/file2.ts
    fixture.createBranch('pr-2', 'main');
    fixture.checkout('pr-2');
    fixture.commitFile('src/b/file2.ts', 'b modified\n', 'mod b');
    const pr2TreeOid = fixture.getTreeOid('pr-2');

    const profile1 = await pruner.buildProfile(1, baseTreeOid, pr1TreeOid);
    const profile2 = await pruner.buildProfile(2, baseTreeOid, pr2TreeOid);

    const result = pruner.evaluatePair(profile1, profile2);
    expect(result.shouldEvaluate).toBe(false);
    expect(result.reason).toBe('pruned');
  });

  it('catches directory rename vs new file via vanishedDirs and captures CONFLICT (file location) in merge (Test 3)', async () => {
    // 1. Initial state on main: src/foo has two files
    fixture.commitFile('src/foo/old1.ts', 'console.log("old1");\n', 'init old1');
    fixture.commitFile('src/foo/old2.ts', 'console.log("old2");\n', 'init old2');
    const baseSha = fixture.getRevParse('main');
    const baseTreeOid = fixture.getTreeOid('main');

    // 2. PR A: moves src/foo/ to src/bar/ (emptying src/foo completely)
    fixture.createBranch('pr-a', 'main');
    fixture.checkout('pr-a');
    fixture.renameFile('src/foo/old1.ts', 'src/bar/old1.ts', 'move old1 to bar');
    fixture.renameFile('src/foo/old2.ts', 'src/bar/old2.ts', 'move old2 to bar');
    const prATreeOid = fixture.getTreeOid('pr-a');
    const prASha = fixture.getRevParse('pr-a');

    // 3. PR B: adds new file in src/foo/new.ts
    fixture.createBranch('pr-b', 'main');
    fixture.checkout('pr-b');
    fixture.commitFile('src/foo/new.ts', 'console.log("new file in foo");\n', 'add new.ts');
    const prBTreeOid = fixture.getTreeOid('pr-b');
    const prBSha = fixture.getRevParse('pr-b');

    // 4. Build profiles
    const profileA = await pruner.buildProfile(1, baseTreeOid, prATreeOid);
    const profileB = await pruner.buildProfile(2, baseTreeOid, prBTreeOid);

    // Profile A must have 'src/foo' in vanishedDirs!
    expect(profileA.vanishedDirs).toContain('src/foo');
    // Profile B must have 'src/foo' in parentDirs!
    expect(profileB.parentDirs).toContain('src/foo');

    // Neither share any modifiedFiles!
    const sharedFiles = profileA.modifiedFiles.filter((f) => profileB.modifiedFiles.includes(f));
    expect(sharedFiles.length).toBe(0);

    // But Pruner v3 must prevent pruning through vanishedDirs collision!
    const pruneResult = pruner.evaluatePair(profileA, profileB);
    expect(pruneResult.shouldEvaluate).toBe(true);
    expect(pruneResult.reason).toBe('candidate');
    expect(pruneResult.collisionTypes).toContain('vanished_dir_collision');

    // 5. Evaluate the candidate with merge-tree to confirm CONFLICT (file location)
    const coordinator = new BatchMergeCoordinator({ cwd: fixture.dir, sandbox });
    const results = await coordinator.evaluateBatch([
      { id: 'pair-a-b', base: baseSha, branchA: prASha, branchB: prBSha },
    ]);

    const evalResult = results.get('pair-a-b');
    expect(evalResult).toBeDefined();
    expect(evalResult?.status).toBe('conflict');

    if (evalResult?.status === 'conflict') {
      const fileLocConflict = evalResult.conflicts.find((c) => c.category === 'file_location');
      expect(fileLocConflict).toBeDefined();
      expect(fileLocConflict?.rawType).toContain('CONFLICT');
      expect(fileLocConflict?.message).toContain('CONFLICT (file location)');
    }
  });

  it('skips evaluation for mega-PRs exceeding maxFilesPerPR', async () => {
    const customPruner = new PathPruner(runner, { maxFilesPerPR: 2 });
    const profileA = {
      prNumber: 1,
      modifiedFiles: ['f1.ts', 'f2.ts', 'f3.ts'],
      parentDirs: [],
      vanishedDirs: [],
    };
    const profileB = {
      prNumber: 2,
      modifiedFiles: ['f1.ts'],
      parentDirs: [],
      vanishedDirs: [],
    };

    const result = customPruner.evaluatePair(profileA, profileB);
    expect(result.shouldEvaluate).toBe(false);
    expect(result.reason).toBe('mega_pr');
  });
});
