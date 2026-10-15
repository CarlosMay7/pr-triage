export type ConflictCategory =
  | 'content'
  | 'add/add'
  | 'modify/delete'
  | 'rename/delete'
  | 'rename/rename'
  | 'file/directory'
  | 'file_location'
  | 'directory_rename_split'
  | 'distinct_types'
  | 'rename_collision'
  | 'mode'
  | 'submodule'
  | 'binary'
  | 'unknown';

export interface ConflictDetail {
  /** Rutas involucradas (1 a 3 rutas en renombres o file location) */
  paths: string[];
  /** Cadena cruda emitida por merge-ort, ej. 'CONFLICT (file location)' */
  rawType: string;
  category: ConflictCategory;
  message: string;
}

export type MergeEvaluation =
  | { status: 'clean'; treeOid: string }
  | { status: 'conflict'; treeOid: string; conflicts: ConflictDetail[] }
  | {
      status: 'error';
      reason: 'unrelated_histories' | 'missing_objects' | 'git_fatal';
      stderr: string;
    }
  | { status: 'timeout'; timeoutMs: number };

export type PairEvaluationStatus =
  | { state: 'pruned' }
  | { state: 'evaluated'; evaluation: MergeEvaluation }
  | {
      state: 'skipped';
      reason: 'time_budget_exceeded' | 'mega_pr' | 'base_conflict';
    };

export interface PullRequestRef {
  number: number;
  title: string;
  /** Null si el usuario fue eliminado de GitHub (@ghost) */
  author: string | null;
  /** 'owner/repo' del origen para desambiguar ramas entre forks */
  headRepo: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  baseSha: string;
  draft: boolean;
  updatedAt: string;
  lastCiCommitSha?: string;
  lastCiBaseSha?: string;
}

export interface PRPathProfile {
  prNumber: number;
  /** Arreglos JSON-serializables (en lugar de Set) */
  modifiedFiles: string[];
  parentDirs: string[];
  vanishedDirs: string[];
}

export interface PRDiagnostics {
  prNumber: number;
  title: string;
  author: string | null;
  headRepo: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseEvaluation: MergeEvaluation;
  isNoOp: boolean;
  stackedOnPR?: number;
  includesCommitsOfPRs: number[];
  subsumedByPRs: number[];
  identicalTreePRs: number[];
  commitsBehindBase: number;
  commitsAheadOfBase: number;
  isStale: boolean;
}

export interface PairRecord {
  prA: number;
  prB: number;
  status: PairEvaluationStatus;
}

export interface MergeTrainCandidate {
  /** Hash determinista de orderedPrNumbers (ej. 'train-a1b2c3d4') */
  groupId: string;
  baseRefName: string;
  orderedPrNumbers: number[];
  combinedTreeOid: string;
  verifiedByRealCommitChain: boolean;
  touchedFilesCount: number;
}

export interface BaseBranchReport {
  baseRefName: string;
  baseSha: string;
  baseTreeOid: string;
  diagnostics: PRDiagnostics[];
  pairMatrix: PairRecord[];
  mergeTrains: MergeTrainCandidate[];
}

export interface TriageReport {
  repo: string;
  toolVersion: string;
  timestamp: string;
  gitVersion: string;
  gitExecutionMode: 'native-trees-2.45+' | 'commit-tree-fallback-2.40+';
  effectiveGitConfig: Record<string, string>;
  assumedMergeMethod: 'merge' | 'squash' | 'rebase';
  executionTimeMs: number;
  partial: boolean;
  skippedPRs: Array<{ prNumber: number; reason: string }>;
  reportsByBase: Record<string, BaseBranchReport>;
}
