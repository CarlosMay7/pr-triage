import { PRPathProfile } from '../types.js';
import { GitRunner } from './git-runner.js';

export interface PrunerOptions {
  maxFilesPerPR?: number;
  ignoreHotFiles?: string[];
}

export interface PairPruneResult {
  shouldEvaluate: boolean;
  reason: 'candidate' | 'pruned' | 'mega_pr';
  collisionTypes: Array<'file_overlap' | 'file_dir_collision' | 'vanished_dir_collision'>;
}

export class PathPruner {
  private readonly runner: GitRunner;
  private readonly options: Required<PrunerOptions>;
  // Cache of directory file counts for base trees: Map<baseTreeOid, Map<dirPath, fileCount>>
  private readonly baseDirCountsCache = new Map<string, Map<string, number>>();

  constructor(runner: GitRunner, options?: PrunerOptions) {
    this.runner = runner;
    this.options = {
      maxFilesPerPR: options?.maxFilesPerPR ?? 500,
      ignoreHotFiles: options?.ignoreHotFiles ?? [],
    };
  }

  /**
   * Computes the map of file counts per directory in a base tree.
   */
  public async getBaseDirCounts(baseTreeOid: string): Promise<Map<string, number>> {
    const cached = this.baseDirCountsCache.get(baseTreeOid);
    if (cached) return cached;

    const counts = new Map<string, number>();
    const { stdout } = await this.runner.exec(['ls-tree', '-r', '--name-only', '-z', baseTreeOid]);

    if (!stdout) {
      this.baseDirCountsCache.set(baseTreeOid, counts);
      return counts;
    }

    const files = stdout.split('\0').filter((f) => f.length > 0);
    for (const file of files) {
      const parentDirs = this.computeParentDirs(file);
      for (const dir of parentDirs) {
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }

    this.baseDirCountsCache.set(baseTreeOid, counts);
    return counts;
  }

  /**
   * Builds the PRPathProfile (modifiedFiles, parentDirs, vanishedDirs)
   * for a PR given its base tree and projected tree.
   */
  public async buildProfile(
    prNumber: number,
    baseTreeOid: string,
    prTreeOid: string
  ): Promise<PRPathProfile> {
    const baseCounts = await this.getBaseDirCounts(baseTreeOid);

    const { stdout } = await this.runner.exec([
      'diff-tree',
      '-r',
      '--name-status',
      '-z',
      baseTreeOid,
      prTreeOid,
    ]);

    const modifiedFilesSet = new Set<string>();
    const parentDirsSet = new Set<string>();
    const removedCountByDir = new Map<string, number>();
    const addedCountByDir = new Map<string, number>();

    if (stdout) {
      const tokens = stdout.split('\0').filter((t) => t.length > 0);
      let i = 0;
      while (i < tokens.length) {
        const status = tokens[i++];
        if (!status) break;

        const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
        if (isRenameOrCopy) {
          const srcPath = tokens[i++];
          const dstPath = tokens[i++];

          if (srcPath && dstPath) {
            modifiedFilesSet.add(srcPath);
            modifiedFilesSet.add(dstPath);

            // Removed from src
            for (const d of this.computeParentDirs(srcPath)) {
              removedCountByDir.set(d, (removedCountByDir.get(d) ?? 0) + 1);
            }
            // Added to dst
            for (const d of this.computeParentDirs(dstPath)) {
              addedCountByDir.set(d, (addedCountByDir.get(d) ?? 0) + 1);
            }
          }
        } else {
          const filePath = tokens[i++];
          if (filePath) {
            modifiedFilesSet.add(filePath);

            if (status.startsWith('D')) {
              for (const d of this.computeParentDirs(filePath)) {
                removedCountByDir.set(d, (removedCountByDir.get(d) ?? 0) + 1);
              }
            } else if (status.startsWith('A')) {
              for (const d of this.computeParentDirs(filePath)) {
                addedCountByDir.set(d, (addedCountByDir.get(d) ?? 0) + 1);
              }
            }
          }
        }
      }
    }

    // Populate parentDirs from all modified files
    for (const file of modifiedFilesSet) {
      for (const dir of this.computeParentDirs(file)) {
        parentDirsSet.add(dir);
      }
    }

    // Determine vanishedDirs:
    // A directory vanished if base had files in it, and removedCount == baseCount and addedCount == 0
    const vanishedDirsSet = new Set<string>();
    for (const [dir, baseCount] of baseCounts.entries()) {
      const removed = removedCountByDir.get(dir) ?? 0;
      const added = addedCountByDir.get(dir) ?? 0;
      if (baseCount > 0 && removed >= baseCount && added === 0) {
        vanishedDirsSet.add(dir);
      }
    }

    return {
      prNumber,
      modifiedFiles: Array.from(modifiedFilesSet).sort(),
      parentDirs: Array.from(parentDirsSet).sort(),
      vanishedDirs: Array.from(vanishedDirsSet).sort(),
    };
  }

  /**
   * Checks whether two PR profiles should be evaluated in Phase 2.
   */
  public evaluatePair(profileA: PRPathProfile, profileB: PRPathProfile): PairPruneResult {
    // 1. Check mega PR limits
    if (
      profileA.modifiedFiles.length > this.options.maxFilesPerPR ||
      profileB.modifiedFiles.length > this.options.maxFilesPerPR
    ) {
      return {
        shouldEvaluate: false,
        reason: 'mega_pr',
        collisionTypes: [],
      };
    }

    const collisionTypes: Array<'file_overlap' | 'file_dir_collision' | 'vanished_dir_collision'> = [];

    // Filter out ignored hot files if checking overlap
    const filesA = new Set(
      profileA.modifiedFiles.filter((f) => !this.options.ignoreHotFiles.includes(f))
    );
    const filesB = new Set(
      profileB.modifiedFiles.filter((f) => !this.options.ignoreHotFiles.includes(f))
    );

    const parentsA = new Set(profileA.parentDirs);
    const parentsB = new Set(profileB.parentDirs);

    const vanishedA = new Set(profileA.vanishedDirs);
    const vanishedB = new Set(profileB.vanishedDirs);

    // 1. File overlap: modifiedFiles_A ∩ modifiedFiles_B != ∅
    for (const fileA of filesA) {
      if (filesB.has(fileA)) {
        collisionTypes.push('file_overlap');
        break;
      }
    }

    // 2. File / Directory collision:
    // modifiedFiles_A ∩ parentDirs_B != ∅  or  parentDirs_A ∩ modifiedFiles_B != ∅
    let fileDirCollision = false;
    for (const fileA of filesA) {
      if (parentsB.has(fileA)) {
        fileDirCollision = true;
        break;
      }
    }
    if (!fileDirCollision) {
      for (const fileB of filesB) {
        if (parentsA.has(fileB)) {
          fileDirCollision = true;
          break;
        }
      }
    }
    if (fileDirCollision) {
      collisionTypes.push('file_dir_collision');
    }

    // 3. Vanished Directory collision (Directory rename or complete deletion):
    // vanishedDirs_A ∩ parentDirs_B != ∅  or  parentDirs_A ∩ vanishedDirs_B != ∅
    let vanishedDirCollision = false;
    for (const vA of vanishedA) {
      if (parentsB.has(vA)) {
        vanishedDirCollision = true;
        break;
      }
    }
    if (!vanishedDirCollision) {
      for (const vB of vanishedB) {
        if (parentsA.has(vB)) {
          vanishedDirCollision = true;
          break;
        }
      }
    }
    if (vanishedDirCollision) {
      collisionTypes.push('vanished_dir_collision');
    }

    if (collisionTypes.length > 0) {
      return {
        shouldEvaluate: true,
        reason: 'candidate',
        collisionTypes,
      };
    }

    return {
      shouldEvaluate: false,
      reason: 'pruned',
      collisionTypes: [],
    };
  }

  private computeParentDirs(filePath: string): string[] {
    const parts = filePath.split('/');
    const dirs: string[] = [];
    let current = '';
    // Skip the last part (the file name)
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      dirs.push(current);
    }
    return dirs;
  }
}
