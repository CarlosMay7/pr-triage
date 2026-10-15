import { spawn } from 'node:child_process';
import { GitSandbox } from './git-sandbox.js';

export interface GitVersionInfo {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  mode: 'native-trees-2.45+' | 'commit-tree-fallback-2.40+';
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitRunner {
  private sandbox?: GitSandbox;
  private readonly cwd: string;

  constructor(cwd: string, sandbox?: GitSandbox) {
    this.cwd = cwd;
    this.sandbox = sandbox;
  }

  public setSandbox(sandbox: GitSandbox): void {
    this.sandbox = sandbox;
  }

  /**
   * Parse git version string and determine execution mode.
   * Format usually: "git version 2.45.1.windows.1" or "git version 2.43.0"
   */
  public async getVersion(): Promise<GitVersionInfo> {
    const { stdout } = await this.exec(['--version'], { useSandbox: false });
    const match = stdout.match(/git\s+version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!match) {
      throw new Error(`Unable to parse git version from: "${stdout.trim()}"`);
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = match[3] ? parseInt(match[3], 10) : 0;

    if (major < 2 || (major === 2 && minor < 40)) {
      throw new Error(
        `Git version ${major}.${minor}.${patch} is not supported. pr-triage requires Git >= 2.40. Please update Git.`
      );
    }

    const isNativeTrees = major > 2 || (major === 2 && minor >= 45);

    return {
      raw: stdout.trim(),
      major,
      minor,
      patch,
      mode: isNativeTrees ? 'native-trees-2.45+' : 'commit-tree-fallback-2.40+',
    };
  }

  /**
   * Executes a git command with options and sandbox environment.
   */
  public async exec(
    args: string[],
    options?: {
      timeout?: number;
      useSandbox?: boolean;
      useDefaultArgs?: boolean;
      stdin?: string | Buffer;
    }
  ): Promise<GitExecResult> {
    const useSandbox = options?.useSandbox ?? true;
    const useDefaultArgs = options?.useDefaultArgs ?? true;

    const env = useSandbox && this.sandbox ? this.sandbox.getEnv() : process.env;
    const defaultArgs = useDefaultArgs && this.sandbox ? this.sandbox.getDefaultArgs() : [];
    const finalArgs = [...defaultArgs, ...args];

    return new Promise((resolve, reject) => {
      const child = spawn('git', finalArgs, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      let timeoutTimer: NodeJS.Timeout | undefined;
      if (options?.timeout && options.timeout > 0) {
        timeoutTimer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Git command timed out after ${options.timeout}ms: git ${finalArgs.join(' ')}`));
        }, options.timeout);
      }

      if (options?.stdin !== undefined) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(err);
      });

      child.on('close', (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code ?? 0,
        });
      });
    });
  }
}
