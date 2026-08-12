#!/usr/bin/env node
/**
 * Regression test for the symlink out-of-project write vulnerability
 * (bug bounty: "iOS integration follows project symlinks and overwrites files
 * outside the selected project").
 *
 * Reproduces the reported PoC filesystem layout — `<projectPath>/AppticsManager`
 * is a symlink to a directory outside the project — and asserts that the shared
 * containment primitive `resolveContainedPath()` (now used by every integration
 * file-write sink) fails closed instead of following the symlink.
 *
 * No Xcode project or Apptics credentials required.
 *
 * Usage:
 *   npm run build && node scripts/test-symlink-containment.mjs
 */

import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MODULE_PATH = path.join(ROOT, "dist", "sdk-integration", "pathContainment.js");

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function fail(name, detail) {
  failed += 1;
  console.error(`  ✗ ${name}\n      ${detail}`);
}

async function expectThrows(name, fn) {
  try {
    const result = await fn();
    fail(name, `expected a thrown error but call returned: ${result}`);
  } catch (err) {
    ok(`${name} (rejected: ${String(err.message).split("\n")[0]})`);
  }
}

async function expectResolvesInside(name, fn, projectRealRoot) {
  try {
    const result = await fn();
    const rel = path.relative(projectRealRoot, result);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      ok(`${name} (-> ${result})`);
    } else {
      fail(name, `resolved OUTSIDE project: ${result} (root ${projectRealRoot})`);
    }
  } catch (err) {
    fail(name, `unexpected throw: ${err.message}`);
  }
}

async function main() {
  const { resolveContainedPath } = await import(pathToFileURL(MODULE_PATH).href);

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "apptics-symlink-test-"));
  const lab = path.join(base, "lab-project");
  const outside = path.join(base, "outside");
  await fs.mkdir(lab, { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  // Canonical project root (tmp dirs are commonly behind a /var -> /private symlink on macOS).
  const labReal = await fs.realpath(lab);

  console.log("Scenario A: <projectPath>/AppticsManager is a symlink to an external dir");
  // Layout from PoC 1 & 2.
  await fs.symlink(outside, path.join(lab, "AppticsManager"));
  // PoC 2 seeds an existing external file that the attacker aims to overwrite.
  const sentinelPath = path.join(outside, "profile.mobileconfig");
  await fs.writeFile(sentinelPath, "ORIGINAL_SENTINEL\n", "utf-8");

  // PoC 1: default AppticsManager.swift write must be refused (would escape via symlink).
  await expectThrows("default manager write through symlinked dir is refused", () =>
    resolveContainedPath(lab, path.join("AppticsManager", "AppticsManager.swift"))
  );

  // PoC 2: attacker-chosen basename targeting an existing external file must be refused.
  await expectThrows("overwrite of external file via symlinked dir + basename is refused", () =>
    resolveContainedPath(lab, path.join("AppticsManager", "profile.mobileconfig"))
  );

  // The external file must be untouched (resolveContainedPath performs no writes).
  const sentinel = await fs.readFile(sentinelPath, "utf-8");
  if (sentinel === "ORIGINAL_SENTINEL\n") {
    ok("external sentinel file left intact");
  } else {
    fail("external sentinel file left intact", `contents changed to: ${JSON.stringify(sentinel)}`);
  }

  console.log("Scenario B: absolute path traversal / escape attempts are refused");
  await expectThrows("absolute path outside project is refused", () =>
    resolveContainedPath(lab, path.join(outside, "evil.swift"))
  );
  await expectThrows("../ traversal escaping project is refused", () =>
    resolveContainedPath(lab, path.join("..", "outside", "evil.swift"))
  );

  console.log("Scenario C: legitimate in-project writes still succeed");
  const cleanLab = path.join(base, "clean-project");
  await fs.mkdir(path.join(cleanLab, "existing"), { recursive: true });
  const cleanReal = await fs.realpath(cleanLab);
  await expectResolvesInside(
    "new nested file inside project resolves within root",
    () => resolveContainedPath(cleanLab, path.join("AppticsManager", "AppticsManager.swift")),
    cleanReal
  );
  await expectResolvesInside(
    "file in an existing subdirectory resolves within root",
    () => resolveContainedPath(cleanLab, path.join("existing", "apptics-config.plist")),
    cleanReal
  );

  console.log("Scenario D: symlink that stays INSIDE the project is allowed");
  // A symlinked group folder pointing to another folder within the same project is fine.
  await fs.mkdir(path.join(cleanLab, "realGroup"), { recursive: true });
  await fs.symlink(path.join(cleanLab, "realGroup"), path.join(cleanLab, "linkGroup"));
  await expectResolvesInside(
    "write through in-project symlink resolves within root",
    () => resolveContainedPath(cleanLab, path.join("linkGroup", "AppticsManager.swift")),
    cleanReal
  );

  console.log("Scenario E: project accessed via a symlinked root is still contained");
  // The project root itself may be reached through a symlink (e.g. /tmp -> /private/tmp).
  const linkRoot = path.join(base, "link-to-clean");
  await fs.symlink(cleanLab, linkRoot);
  await expectResolvesInside(
    "write via symlinked project root resolves within canonical root",
    () => resolveContainedPath(linkRoot, "AppticsManager/AppticsManager.swift"),
    cleanReal
  );

  await fs.rm(base, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
