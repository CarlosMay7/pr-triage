import { ConflictCategory, ConflictDetail, MergeEvaluation } from '../types.js';

export function categorizeConflict(rawType: string): ConflictCategory {
  const normalized = rawType.toLowerCase().trim();
  if (normalized.includes('content')) return 'content';
  if (normalized.includes('add/add')) return 'add/add';
  if (normalized.includes('modify/delete')) return 'modify/delete';
  if (normalized.includes('rename/delete')) return 'rename/delete';
  if (normalized.includes('rename/rename')) return 'rename/rename';
  if (normalized.includes('file/directory')) return 'file/directory';
  if (normalized.includes('file location')) return 'file_location';
  if (normalized.includes('directory rename split')) return 'directory_rename_split';
  if (normalized.includes('distinct types')) return 'distinct_types';
  if (normalized.includes('rename collision')) return 'rename_collision';
  if (normalized.includes('mode')) return 'mode';
  if (normalized.includes('submodule')) return 'submodule';
  if (normalized.includes('binary')) return 'binary';
  return 'unknown';
}

export interface ParseResult {
  evaluation: MergeEvaluation;
  bytesConsumed: number;
}

/**
 * Parses a single block from the output of `git merge-tree --write-tree --stdin -z`.
 * 
 * Grammar:
 * - Clean:
 *   '1' \0 <tree-oid> \0 \0
 * - Conflict:
 *   '0' \0 <tree-oid> \0
 *   [ <mode> SP <oid> SP <stage> TAB <path> \0 ... ] \0   <-- End of conflicted index entries
 *   [ <num-paths> \0 (<path> \0){num-paths} <raw-type> \0 <msg> \0 ... ] \0 <-- End of messages
 */
export function parseMergeTreeBlock(
  buffer: Buffer,
  startOffset = 0,
  oidLabels?: Map<string, string>
): ParseResult | null {
  // Find all NUL byte positions starting from startOffset
  // To avoid parsing an incomplete buffer, we ensure the block is terminated properly
  let offset = startOffset;
  const len = buffer.length;

  if (offset >= len) return null;

  const statusChar = String.fromCharCode(buffer[offset]);
  if (statusChar !== '1' && statusChar !== '0') {
    throw new Error(`Invalid status character in merge-tree output: '${statusChar}' at offset ${offset}`);
  }

  // Next byte must be NUL
  if (offset + 1 >= len || buffer[offset + 1] !== 0) {
    return null; // incomplete
  }
  offset += 2;

  // Read tree OID (until next \0)
  const treeOidEnd = buffer.indexOf(0, offset);
  if (treeOidEnd === -1) return null;
  const treeOid = buffer.toString('utf8', offset, treeOidEnd);
  offset = treeOidEnd + 1;

  if (statusChar === '1') {
    // Clean block ends with an empty token (another \0)
    if (offset >= len) return null;
    if (buffer[offset] !== 0) {
      throw new Error(`Expected NUL terminating clean block at offset ${offset}`);
    }
    offset += 1; // consume terminating \0

    return {
      evaluation: {
        status: 'clean',
        treeOid,
      },
      bytesConsumed: offset - startOffset,
    };
  }

  // Conflict block:
  // 1. Conflicted index entries section (ends with \0\0 -> when an entry is empty)
  while (true) {
    if (offset >= len) return null; // incomplete
    if (buffer[offset] === 0) {
      // Empty entry terminates the index entries section
      offset += 1;
      break;
    }
    // Read non-empty index entry
    const entryEnd = buffer.indexOf(0, offset);
    if (entryEnd === -1) return null;
    // We don't strictly need to store raw index entries for triage diagnostics,
    // as conflict details come from the messages section, but we consume them.
    offset = entryEnd + 1;
  }

  // 2. Messages section (ends with \0\0 -> when num-paths entry is empty)
  const conflicts: ConflictDetail[] = [];
  const compiledOidMatchers =
    oidLabels && oidLabels.size > 0
      ? Array.from(oidLabels.entries()).map(([oid, label]) => ({
          oid,
          label,
          regex: new RegExp(`\\b${oid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
        }))
      : [];

  while (true) {
    if (offset >= len) return null; // incomplete
    if (buffer[offset] === 0) {
      // Empty entry terminates the messages section
      offset += 1;
      break;
    }

    // Read num-paths
    const numPathsEnd = buffer.indexOf(0, offset);
    if (numPathsEnd === -1) return null;
    const numPathsStr = buffer.toString('utf8', offset, numPathsEnd);
    const numPaths = parseInt(numPathsStr, 10);
    if (isNaN(numPaths)) {
      throw new Error(`Expected numeric num-paths in merge-tree message, got: "${numPathsStr}"`);
    }
    offset = numPathsEnd + 1;

    // Read paths
    const paths: string[] = [];
    for (let i = 0; i < numPaths; i++) {
      const pathEnd = buffer.indexOf(0, offset);
      if (pathEnd === -1) return null;
      paths.push(buffer.toString('utf8', offset, pathEnd));
      offset = pathEnd + 1;
    }

    // Read raw-type
    const rawTypeEnd = buffer.indexOf(0, offset);
    if (rawTypeEnd === -1) return null;
    const rawType = buffer.toString('utf8', offset, rawTypeEnd);
    offset = rawTypeEnd + 1;

    // Read message
    const msgEnd = buffer.indexOf(0, offset);
    if (msgEnd === -1) return null;
    let message = buffer.toString('utf8', offset, msgEnd).trim();
    offset = msgEnd + 1;

    // Filter pseudo-conflicts: discard Auto-merging
    if (rawType.startsWith('Auto-merging')) {
      continue;
    }

    // Replace OIDs with human labels if provided
    if (compiledOidMatchers.length > 0) {
      for (const { oid, label, regex } of compiledOidMatchers) {
        if (message.includes(oid)) {
          message = message.replace(regex, label);
        }
      }
    }

    conflicts.push({
      paths,
      rawType,
      category: categorizeConflict(rawType),
      message,
    });
  }

  return {
    evaluation: {
      status: 'conflict',
      treeOid,
      conflicts,
    },
    bytesConsumed: offset - startOffset,
  };
}

/**
 * Parses all complete blocks from a buffer.
 */
export function parseAllMergeTreeBlocks(
  buffer: Buffer,
  oidLabels?: Map<string, string>
): { evaluations: MergeEvaluation[]; bytesConsumed: number } {
  const evaluations: MergeEvaluation[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const result = parseMergeTreeBlock(buffer, offset, oidLabels);
    if (!result) {
      break; // incomplete block at end of buffer
    }
    evaluations.push(result.evaluation);
    offset += result.bytesConsumed;
  }

  return { evaluations, bytesConsumed: offset };
}
