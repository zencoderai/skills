#!/usr/bin/env node
//
// Parse a unified diff (file or stdin) and output a JSON hunk map:
//
//   {
//     "files": [
//       {
//         "path": "src/foo.ts",
//         "status": "modified",
//         "hunks": [
//           { "old_start": 10, "old_count": 5, "new_start": 10, "new_count": 8 }
//         ]
//       }
//     ]
//   }
//
// Usage:
//   node diff_changed_ranges.js <diff-file>        # read from file
//   cat foo.patch | node diff_changed_ranges.js -   # read from stdin
//   node diff_changed_ranges.js --help
//

"use strict";

const fs = require("fs");
const path = require("path");

const HUNK_HEADER_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripDiffPath(p) {
  if (p === "/dev/null" || p === "") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function statusFromPaths(oldPath, newPath) {
  if (oldPath === "/dev/null" && newPath !== "/dev/null") return "added";
  if (oldPath !== "/dev/null" && newPath === "/dev/null") return "deleted";
  if (oldPath !== newPath) return "renamed";
  return "modified";
}

function parseUnifiedDiff(diffText) {
  const files = [];
  let currentOldPath = "";
  let currentNewPath = "";
  let currentFileKey = "";
  let currentHunks = [];

  function flush() {
    if (!currentFileKey) return;
    files.push({
      path: currentFileKey,
      status: statusFromPaths(currentOldPath, currentNewPath),
      hunks: currentHunks,
    });
    currentOldPath = "";
    currentNewPath = "";
    currentFileKey = "";
    currentHunks = [];
  }

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      flush();
      const parts = line.split(" ");
      if (parts.length >= 4) {
        currentOldPath = stripDiffPath(parts[2]);
        currentNewPath = stripDiffPath(parts[3]);
        currentFileKey = currentNewPath;
      } else {
        currentOldPath = "";
        currentNewPath = "";
        currentFileKey = "";
      }
      currentHunks = [];
      continue;
    }

    if (line.startsWith("--- ")) {
      currentOldPath = stripDiffPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentNewPath = stripDiffPath(line.slice(4).trim());
      currentFileKey =
        currentNewPath !== "/dev/null" ? currentNewPath : currentOldPath;
      continue;
    }

    const match = line.match(HUNK_HEADER_RE);
    if (match) {
      currentHunks.push({
        old_start: parseInt(match[1], 10),
        old_count: parseInt(match[2] ?? "1", 10),
        new_start: parseInt(match[3], 10),
        new_count: parseInt(match[4] ?? "1", 10),
      });
      continue;
    }
  }

  flush();
  return files;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node diff_changed_ranges.js <diff-file | ->\n\n" +
        "Parse a unified diff and output a JSON hunk map.\n" +
        "Use '-' to read from stdin.\n"
    );
    process.exit(0);
  }

  const source = args[0];
  let diffText;

  if (!source || source === "-") {
    diffText = fs.readFileSync(0, "utf-8"); // stdin
  } else {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }
    diffText = fs.readFileSync(resolved, "utf-8");
  }

  const files = parseUnifiedDiff(diffText);
  const payload = { files };
  console.log(JSON.stringify(payload, null, 2));
}

main();
