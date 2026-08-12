/**
 * Filesystem containment helpers for SDK integration tools.
 *
 * The integration MCP tools are invoked against project directories whose contents
 * are NOT inherently trusted (e.g. cloned, generated, or agent-produced repositories).
 * Every generated file must land strictly inside the selected project directory. A
 * project must not be able to redirect a write outside its own tree by planting a
 * symbolic link at a write location (e.g. `<projectPath>/AppticsManager` -> `/somewhere/else`).
 *
 * `path.join(projectPath, ...)` alone does NOT guarantee containment: Node's fs APIs
 * follow symlinks, and `path.basename()` only strips directory traversal from the
 * filename — it does nothing about a symlinked containing directory. This module
 * canonicalizes the target through `realpath` and rejects anything that escapes the
 * project root (CWE-59 / CWE-22).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** True when `child` is `root` itself or nested beneath it (lexical check on already-canonical paths). */
function isWithin(root: string, child: string): boolean {
  if (child === root) {
    return true;
  }
  const rel = path.relative(root, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Canonicalize a would-be write target and guarantee it stays inside `projectPath`,
 * refusing to follow any symlink that escapes the selected project directory.
 *
 * All symlinks in the already-existing portion of the path are resolved, so the
 * returned path is safe to `mkdir`/`writeFile`/`copyFile` against: a subsequent write
 * cannot traverse an escaping symlink. Not-yet-existing trailing segments are appended
 * to the canonical base and re-checked.
 *
 * @param projectPath The selected project root (the containment boundary). Must exist.
 * @param targetPath  The desired write path, absolute or relative to `projectPath`.
 * @returns A canonical absolute path guaranteed to be within the resolved project root.
 * @throws  If the target resolves outside the project root (e.g. via a symlink).
 */
export async function resolveContainedPath(
  projectPath: string,
  targetPath: string
): Promise<string> {
  const realRoot = await fs.realpath(path.resolve(projectPath));
  const absTarget = path.resolve(projectPath, targetPath);

  // Find the deepest ancestor of absTarget that already exists on disk.
  let existing = absTarget;
  const missingSegments: string[] = [];
  while (true) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        // Reached the filesystem root without finding an existing ancestor.
        break;
      }
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }

  // Canonicalize the existing ancestor: this resolves EVERY symlink in the existing chain,
  // including a symlinked containing directory or a symlinked target file.
  const realExisting = await fs.realpath(existing);

  if (!isWithin(realRoot, realExisting)) {
    throw new Error(
      `Refusing to write outside the selected project directory. ` +
        `Path "${absTarget}" resolves to "${realExisting}", which is outside "${realRoot}". ` +
        `A symlink inside the project may be redirecting the write.`
    );
  }

  // Rebuild the full target from the canonical base plus the not-yet-created segments.
  const safeTarget =
    missingSegments.length > 0 ? path.join(realExisting, ...missingSegments) : realExisting;

  if (!isWithin(realRoot, safeTarget)) {
    throw new Error(
      `Refusing to write outside the selected project directory: ` +
        `"${safeTarget}" is outside "${realRoot}".`
    );
  }

  return safeTarget;
}
