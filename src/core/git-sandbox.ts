import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface GitSandboxOptions {
  repoDir: string;
}

export class GitSandbox {
  public readonly repoDir: string;
  public readonly scratchObjDir: string;
  private readonly gitDir: string;
  private disposed = false;

  constructor(options: GitSandboxOptions) {
    this.repoDir = path.resolve(options.repoDir);
    // Find the real .git directory (could be a directory or a worktree file)
    const dotGitPath = path.join(this.repoDir, '.git');
    if (!fs.existsSync(dotGitPath)) {
      throw new Error(`Directory is not a git repository: ${this.repoDir}`);
    }

    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) {
      this.gitDir = dotGitPath;
    } else {
      // It's a gitlink file (worktree or submodule), read gitdir pointer
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match && match[1]) {
        this.gitDir = path.resolve(this.repoDir, match[1]);
      } else {
        this.gitDir = dotGitPath;
      }
    }

    // Create scratch directory for ephemeral objects
    this.scratchObjDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pr-triage-objs-')
    );
  }

  /**
   * Returns environment variables that isolate git object writes
   * into our ephemeral scratch directory.
   */
  public getEnv(): NodeJS.ProcessEnv {
    if (this.disposed) {
      throw new Error('Cannot use disposed GitSandbox');
    }

    const repoObjectsDir = path.join(this.gitDir, 'objects');

    return {
      ...process.env,
      GIT_OBJECT_DIRECTORY: this.scratchObjDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjectsDir,
    };
  }

  /**
   * Returns default deterministic flags to prepend to all git commands.
   */
  public getDefaultArgs(): string[] {
    return [
      '-c', 'gc.auto=0',
      '-c', 'merge.directoryRenames=conflict',
      '-c', 'core.quotePath=false',
    ];
  }

  /**
   * Cleans up the scratch directory recursively.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      if (fs.existsSync(this.scratchObjDir)) {
        fs.rmSync(this.scratchObjDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors on temp dirs
    }
  }

  public [Symbol.dispose](): void {
    this.dispose();
  }
}
