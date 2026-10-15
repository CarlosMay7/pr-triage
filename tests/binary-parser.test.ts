import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitFixture } from './helpers/git-fixture.js';
import { GitSandbox } from '../src/core/git-sandbox.js';
import { BatchMergeCoordinator, MergeTask, assertValidGitRef } from '../src/core/batch-merge.js';
import { parseMergeTreeBlock } from '../src/core/binary-parser.js';

describe('Binary Parser & Batch Coordinator (Test 4 from RFC v3.0)', () => {
  let fixture: GitFixture;
  let sandbox: GitSandbox;

  beforeEach(() => {
    fixture = new GitFixture();
    sandbox = new GitSandbox({ repoDir: fixture.dir });
  });

  afterEach(() => {
    sandbox.dispose();
    fixture.dispose();
  });

  it('correctly handles mixed batches: clean merges, conflicts with auto-merges filtered, and crash recovery (exit 128)', async () => {
    // Baseline commit on main
    fixture.commitFile('common.txt', 'base content\n', 'initial main commit');
    fixture.commitFile('auto.txt', 'line 1\nline 2\nline 3\n', 'file for auto merge');
    fixture.commitFile('conf.txt', 'original line\n', 'file for conflict');
    const mainSha = fixture.getRevParse('main');

    // Branch 1: clean disjoint addition
    fixture.createBranch('branch-clean-1', 'main');
    fixture.checkout('branch-clean-1');
    fixture.commitFile('new-file-1.txt', 'content 1\n', 'add clean 1');
    const clean1Sha = fixture.getRevParse('branch-clean-1');

    // Branch 2 & 3: conflict on conf.txt, plus clean auto-merge on auto.txt
    fixture.createBranch('branch-conf-a', 'main');
    fixture.checkout('branch-conf-a');
    // modify top of auto.txt
    fixture.commitFile('auto.txt', 'line 1 - modified A\nline 2\nline 3\n', 'auto mod A');
    fixture.commitFile('conf.txt', 'conflict A\n', 'conflict A');
    const confASha = fixture.getRevParse('branch-conf-a');

    fixture.createBranch('branch-conf-b', 'main');
    fixture.checkout('branch-conf-b');
    // modify bottom of auto.txt (compatible 3-way merge)
    fixture.commitFile('auto.txt', 'line 1\nline 2\nline 3 - modified B\n', 'auto mod B');
    fixture.commitFile('conf.txt', 'conflict B\n', 'conflict B');
    const confBSha = fixture.getRevParse('branch-conf-b');

    // Branch 4: orphan branch with unrelated history to trigger exit 128
    fixture.git(['checkout', '--orphan', 'orphan-unrelated']);
    fixture.commitFile('unrelated.txt', 'completely detached\n', 'orphan commit');
    const orphanSha = fixture.getRevParse('orphan-unrelated');

    // Branch 5: clean disjoint addition after the crash
    fixture.createBranch('branch-clean-2', 'main');
    fixture.checkout('branch-clean-2');
    fixture.commitFile('new-file-2.txt', 'content 2\n', 'add clean 2');
    const clean2Sha = fixture.getRevParse('branch-clean-2');

    fixture.checkout('main');

    const coordinator = new BatchMergeCoordinator({
      cwd: fixture.dir,
      sandbox,
    });

    const tasks: MergeTask[] = [
      { id: 'task-clean-1', base: mainSha, branchA: mainSha, branchB: clean1Sha },
      { id: 'task-conflict', base: mainSha, branchA: confASha, branchB: confBSha },
      { id: 'task-unrelated-crash', branchA: mainSha, branchB: orphanSha },
      { id: 'task-clean-2', base: mainSha, branchA: mainSha, branchB: clean2Sha },
    ];

    const results = await coordinator.evaluateBatch(tasks);

    // 1. Task Clean 1
    const resClean1 = results.get('task-clean-1');
    expect(resClean1).toBeDefined();
    expect(resClean1?.status).toBe('clean');
    if (resClean1?.status === 'clean') {
      expect(resClean1.treeOid).toMatch(/^[0-9a-f]{40}$/);
    }

    // 2. Task Conflict
    const resConf = results.get('task-conflict');
    expect(resConf).toBeDefined();
    expect(resConf?.status).toBe('conflict');
    if (resConf?.status === 'conflict') {
      expect(resConf.treeOid).toMatch(/^[0-9a-f]{40}$/);
      // Auto-merging of auto.txt must be filtered out!
      const autoMergeEntry = resConf.conflicts.find((c) => c.rawType.includes('Auto-merging'));
      expect(autoMergeEntry).toBeUndefined();

      // CONFLICT on conf.txt must be retained and categorized
      const confEntry = resConf.conflicts.find((c) => c.paths.includes('conf.txt'));
      expect(confEntry).toBeDefined();
      expect(confEntry?.category).toBe('content');
      expect(confEntry?.rawType).toContain('CONFLICT');
    }

    // 3. Task Unrelated (Crash Recovery with exit 128)
    const resCrash = results.get('task-unrelated-crash');
    expect(resCrash).toBeDefined();
    expect(resCrash?.status).toBe('error');
    if (resCrash?.status === 'error') {
      expect(resCrash.reason).toBe('unrelated_histories');
      expect(resCrash.stderr).toContain('unrelated histories');
    }

    // 4. Task Clean 2 (Resumed and evaluated after crash!)
    const resClean2 = results.get('task-clean-2');
    expect(resClean2).toBeDefined();
    expect(resClean2?.status).toBe('clean');
    if (resClean2?.status === 'clean') {
      expect(resClean2.treeOid).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('validates git refs to prevent protocol command injection', () => {
    expect(() => assertValidGitRef('main\nother', 'branchA')).toThrow(/Invalid git reference/);
    expect(() => assertValidGitRef('--exec=calc', 'branchA')).toThrow(/Invalid git reference/);
    expect(() => assertValidGitRef('branch with space', 'branchA')).toThrow(/Invalid git reference/);
    expect(() => assertValidGitRef('main..feature', 'branchA')).toThrow(/Invalid git reference/);
    expect(() => assertValidGitRef('valid-branch_123', 'branchA')).not.toThrow();
  });

  it('replaces oidLabels respecting word boundaries', () => {
    const oidLabels = new Map<string, string>([
      ['0d4e4b', '#10 (feature)'],
    ]);

    // Construct a synthetic conflict block with oid in message
    // Grammar: '0'\0<treeOid>\0\0 1\0file.ts\0CONFLICT (content)\0added in 0d4e4b but not in 0d4e4b99\0\0
    const rawMsg = 'added in 0d4e4b but not in 0d4e4b99';
    const buf = Buffer.concat([
      Buffer.from('0\0'),
      Buffer.from('a'.repeat(40) + '\0'),
      Buffer.from('\0'), // empty index entries
      Buffer.from('1\0file.ts\0CONFLICT (content)\0' + rawMsg + '\0\0'),
    ]);

    const parsed = parseMergeTreeBlock(buf, 0, oidLabels);
    expect(parsed).not.toBeNull();
    if (parsed && parsed.evaluation.status === 'conflict') {
      const msg = parsed.evaluation.conflicts[0].message;
      // Exact match '0d4e4b' was replaced
      expect(msg).toContain('added in #10 (feature)');
      // Partial prefix '0d4e4b99' was NOT corrupted
      expect(msg).toContain('0d4e4b99');
    }
  });
});
