import { spawn } from 'node:child_process';
import { GitSandbox } from './git-sandbox.js';
import { MergeEvaluation } from '../types.js';
import { parseMergeTreeBlock } from './binary-parser.js';

export interface MergeTask {
  id: string;
  base?: string;
  branchA: string;
  branchB: string;
}

export interface BatchMergeOptions {
  cwd: string;
  sandbox?: GitSandbox;
  oidLabels?: Map<string, string>;
  timeoutMs?: number;
}

const SAFE_GIT_REF_REGEX = /^[^\s\0~^:?*[\]\\]+$/;

export function assertValidGitRef(ref: string, fieldName: string): void {
  if (!ref || !SAFE_GIT_REF_REGEX.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error(`Invalid git reference in ${fieldName}: "${ref}"`);
  }
}

export class BatchMergeCoordinator {
  private readonly cwd: string;
  private readonly sandbox?: GitSandbox;
  private readonly oidLabels?: Map<string, string>;
  private readonly timeoutMs: number;

  constructor(options: BatchMergeOptions) {
    this.cwd = options.cwd;
    this.sandbox = options.sandbox;
    this.oidLabels = options.oidLabels;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * Evaluates a batch of merge tasks sequentially or across workers,
   * with automatic crash recovery (re-spawning on exit 128 / fatal).
   */
  public async evaluateBatch(tasks: MergeTask[]): Promise<Map<string, MergeEvaluation>> {
    const results = new Map<string, MergeEvaluation>();
    if (tasks.length === 0) return results;

    let currentIndex = 0;

    while (currentIndex < tasks.length) {
      const remainingTasks = tasks.slice(currentIndex);
      const { evaluatedCount, errorOnCurrent, stderr } = await this.runWorkerChunk(
        remainingTasks,
        (taskIndexInChunk, evaluation) => {
          const globalTask = remainingTasks[taskIndexInChunk];
          results.set(globalTask.id, evaluation);
        }
      );

      currentIndex += evaluatedCount;

      if (errorOnCurrent && currentIndex < tasks.length) {
        // The task at currentIndex caused a crash
        const failedTask = tasks[currentIndex];
        let reason: 'unrelated_histories' | 'missing_objects' | 'git_fatal' = 'git_fatal';
        if (stderr.toLowerCase().includes('unrelated histories')) {
          reason = 'unrelated_histories';
        } else if (stderr.toLowerCase().includes('missing') || stderr.toLowerCase().includes('not found')) {
          reason = 'missing_objects';
        }

        results.set(failedTask.id, {
          status: 'error',
          reason,
          stderr: stderr.trim(),
        });

        // Skip the crashing task and continue with the next
        currentIndex += 1;
      }
    }

    return results;
  }

  private runWorkerChunk(
    chunkTasks: MergeTask[],
    onEvaluation: (indexInChunk: number, evalResult: MergeEvaluation) => void
  ): Promise<{ evaluatedCount: number; errorOnCurrent: boolean; stderr: string }> {
    return new Promise((resolve, reject) => {
      // Validate inputs against injection
      for (const task of chunkTasks) {
        if (task.base !== undefined) assertValidGitRef(task.base, 'base');
        assertValidGitRef(task.branchA, 'branchA');
        assertValidGitRef(task.branchB, 'branchB');
      }

      const env = this.sandbox ? this.sandbox.getEnv() : process.env;
      const defaultArgs = this.sandbox ? this.sandbox.getDefaultArgs() : [];
      const args = [...defaultArgs, 'merge-tree', '--write-tree', '--stdin', '-z'];

      const child = spawn('git', args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutBuffer = Buffer.alloc(0);
      let stderrText = '';
      let evaluatedCount = 0;
      let closed = false;
      let parseError: Error | null = null;

      let timer: NodeJS.Timeout | undefined;
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!closed) {
            closed = true;
            child.stdout.removeAllListeners('data');
            child.stderr.removeAllListeners('data');
            child.kill('SIGKILL');
            // Mark remaining in chunk as timeout
            for (let i = evaluatedCount; i < chunkTasks.length; i++) {
              onEvaluation(i, { status: 'timeout', timeoutMs: this.timeoutMs });
            }
            resolve({
              evaluatedCount: chunkTasks.length,
              errorOnCurrent: false,
              stderr: 'Operation timed out',
            });
          }
        }, this.timeoutMs);
      }

      // Handle EPIPE if git exits before stdin finishes writing
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
          reject(err);
        }
      });

      // Write all chunk inputs
      const payload = chunkTasks
        .map((task) =>
          task.base
            ? `${task.base} -- ${task.branchA} ${task.branchB}\n`
            : `${task.branchA} ${task.branchB}\n`
        )
        .join('');

      child.stdin.end(payload);

      child.stdout.on('data', (chunk: Buffer) => {
        if (parseError) return;
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);

        // Try to parse as many blocks as possible
        let offset = 0;
        while (offset < stdoutBuffer.length && evaluatedCount < chunkTasks.length) {
          try {
            const parsed = parseMergeTreeBlock(stdoutBuffer, offset, this.oidLabels);
            if (!parsed) break; // Incomplete block, wait for more data

            onEvaluation(evaluatedCount, parsed.evaluation);
            evaluatedCount++;
            offset += parsed.bytesConsumed;
          } catch (err) {
            parseError = err instanceof Error ? err : new Error(String(err));
            child.kill('SIGKILL');
            break;
          }
        }

        if (offset > 0) {
          stdoutBuffer =
            offset === stdoutBuffer.length
              ? Buffer.alloc(0)
              : Buffer.from(stdoutBuffer.subarray(offset));
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);

        if (parseError) {
          return reject(parseError);
        }

        const errorOnCurrent =
          ((code ?? 0) !== 0 || evaluatedCount < chunkTasks.length) &&
          evaluatedCount < chunkTasks.length;

        resolve({
          evaluatedCount,
          errorOnCurrent,
          stderr: stderrText || (evaluatedCount < chunkTasks.length ? 'Unexpected EOF from git merge-tree' : ''),
        });
      });
    });
  }
}
