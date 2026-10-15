import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export class GitFixture {
  public readonly dir: string;
  private disposed = false;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-triage-fixture-'));
    this.init();
  }

  private init(): void {
    this.git(['init', '--initial-branch=main']);
    this.git(['config', 'user.name', 'Triage Test']);
    this.git(['config', 'user.email', 'test@pr-triage.local']);
    this.git(['config', 'commit.gpgsign', 'false']);
  }

  public git(args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  public commitFile(relPath: string, content: string, message: string): string {
    const fullPath = path.join(this.dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    this.git(['add', relPath]);
    this.git(['commit', '-m', message]);
    return this.getRevParse('HEAD');
  }

  public renameFile(oldPath: string, newPath: string, message: string): string {
    const fullNewPath = path.join(this.dir, newPath);
    fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
    this.git(['mv', oldPath, newPath]);
    this.git(['commit', '-m', message]);
    return this.getRevParse('HEAD');
  }

  public deleteFile(relPath: string, message: string): string {
    this.git(['rm', relPath]);
    this.git(['commit', '-m', message]);
    return this.getRevParse('HEAD');
  }

  public createBranch(branchName: string, startPoint?: string): void {
    if (startPoint) {
      this.git(['branch', branchName, startPoint]);
    } else {
      this.git(['branch', branchName]);
    }
  }

  public checkout(branchName: string): void {
    this.git(['checkout', branchName]);
  }

  public getRevParse(ref: string): string {
    return this.git(['rev-parse', ref]);
  }

  public getTreeOid(ref: string): string {
    return this.git(['rev-parse', `${ref}^{tree}`]);
  }

  public readConfigFile(): string {
    return fs.readFileSync(path.join(this.dir, '.git', 'config'), 'utf8');
  }

  /**
   * Counts loose object files in .git/objects (excluding pack and info)
   */
  public countLooseObjects(): number {
    const objectsDir = path.join(this.dir, '.git', 'objects');
    let count = 0;
    if (!fs.existsSync(objectsDir)) return 0;

    const entries = fs.readdirSync(objectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.length === 2 && /^[0-9a-f]{2}$/i.test(entry.name)) {
        const files = fs.readdirSync(path.join(objectsDir, entry.name));
        count += files.length;
      }
    }
    return count;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (fs.existsSync(this.dir)) {
        fs.rmSync(this.dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore errors on Windows temp removal
    }
  }

  public [Symbol.dispose](): void {
    this.dispose();
  }
}
