#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_LINE_DISTANCE = 5;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

function stripDiffPath(p) {
  if (p === "/dev/null" || p === "") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseUnifiedDiff(diffText) {
  const files = [];
  let currentOldPath = "";
  let currentNewPath = "";
  let currentFileKey = "";
  let currentHunks = [];
  let currentHunk = null;
  let newLineNum = 0;

  function flush() {
    if (!currentFileKey) return;
    const oldPath = currentOldPath;
    const newPath = currentNewPath;
    let status = "modified";
    if (oldPath === "/dev/null" && newPath !== "/dev/null") status = "added";
    else if (oldPath !== "/dev/null" && newPath === "/dev/null") status = "deleted";
    else if (oldPath !== newPath) status = "renamed";
    files.push({ path: currentFileKey, status, hunks: currentHunks });
    currentOldPath = "";
    currentNewPath = "";
    currentFileKey = "";
    currentHunks = [];
    currentHunk = null;
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
      currentHunk = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      currentOldPath = stripDiffPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentNewPath = stripDiffPath(line.slice(4).trim());
      currentFileKey = currentNewPath !== "/dev/null" ? currentNewPath : currentOldPath;
      continue;
    }

    const match = line.match(HUNK_HEADER_RE);
    if (match) {
      currentHunk = {
        old_start: parseInt(match[1], 10),
        old_count: parseInt(match[2] ?? "1", 10),
        new_start: parseInt(match[3], 10),
        new_count: parseInt(match[4] ?? "1", 10),
        added_lines: [],
      };
      newLineNum = currentHunk.new_start;
      currentHunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.added_lines.push(newLineNum);
        newLineNum++;
      } else if (line.startsWith("-")) {
        // deleted line
      } else {
        newLineNum++;
      }
    }
  }

  flush();
  return files;
}

function isLineInHunk(hunk, line) {
  return line >= hunk.new_start && line < hunk.new_start + hunk.new_count;
}

function findNearestValidLine(hunks, line) {
  let bestLine = null;
  let bestDist = Infinity;

  for (const hunk of hunks) {
    const hunkStart = hunk.new_start;
    const hunkEnd = hunk.new_start + hunk.new_count - 1;

    if (isLineInHunk(hunk, line)) {
      return { line, distance: 0 };
    }

    if (line < hunkStart) {
      const dist = hunkStart - line;
      if (dist < bestDist) {
        bestDist = dist;
        bestLine = hunkStart;
      }
    } else if (line > hunkEnd) {
      const dist = line - hunkEnd;
      if (dist < bestDist) {
        bestDist = dist;
        bestLine = hunkEnd;
      }
    }
  }

  if (bestLine !== null) {
    return { line: bestLine, distance: bestDist };
  }
  return null;
}

function adjustComments(payload, hunkMap) {
  const fileMap = new Map();
  for (const f of hunkMap) {
    fileMap.set(f.path, f);
  }

  const validComments = [];
  const bodyFindings = [];

  for (const comment of payload.comments || []) {
    const fileEntry = fileMap.get(comment.path);

    if (!fileEntry || fileEntry.hunks.length === 0) {
      bodyFindings.push(comment);
      continue;
    }

    const nearest = findNearestValidLine(fileEntry.hunks, comment.line);

    if (!nearest) {
      bodyFindings.push(comment);
      continue;
    }

    if (nearest.distance === 0) {
      validComments.push(comment);
    } else if (nearest.distance <= MAX_LINE_DISTANCE) {
      const adjusted = { ...comment, line: nearest.line };
      if (nearest.line !== comment.line) {
        adjusted.body = `> _Original location: line ${comment.line} (adjusted to nearest diff line)_\n\n${comment.body}`;
      }
      validComments.push(adjusted);
    } else {
      bodyFindings.push(comment);
    }
  }

  return { validComments, bodyFindings };
}

function formatBodyFindings(existingBody, bodyFindings) {
  if (bodyFindings.length === 0) return existingBody;

  let extra = "\n\n---\n\n### Findings outside diff range\n\n";
  for (const f of bodyFindings) {
    extra += `#### ${f.path}:${f.line}\n\n${f.body}\n\n`;
  }

  return (existingBody || "") + extra;
}

function buildFallbackPayload(payload) {
  const allComments = payload.comments || [];
  let body = payload.body || "";

  if (allComments.length > 0) {
    body += "\n\n---\n\n### Inline findings (could not post as line comments)\n\n";
    for (const c of allComments) {
      body += `#### ${c.path}:${c.line}\n\n${c.body}\n\n`;
    }
  }

  return { event: payload.event || "COMMENT", body, comments: [] };
}

function ghApi(endpoint, method, inputFile) {
  const args = ["api", endpoint, "--method", method, "--input", inputFile];
  const result = execFileSync("gh", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  return result;
}

function isRecoverableError(err) {
  const msg = (err.stderr || err.message || "").toLowerCase();
  const status = err.status;
  if (status >= 500) return true;
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("econnrefused")) return true;
  if (msg.includes("socket hang up") || msg.includes("network")) return true;
  return false;
}

function is422LineError(err) {
  const output = err.stderr || err.stdout || err.message || "";
  return (output.includes("422") || (err.status && String(err.status).includes("1"))) &&
    output.toLowerCase().includes("line") &&
    (output.toLowerCase().includes("could not be resolved") || output.toLowerCase().includes("pull_review_comment"));
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function extractHttpStatus(err) {
  const text = err.stderr || err.message || "";
  const match = text.match(/HTTP (\d{3})/i);
  return match ? parseInt(match[1], 10) : null;
}

function logApiError(err, context) {
  const httpStatus = extractHttpStatus(err);
  const stderr = err.stderr || "";
  const stdout = err.stdout || "";
  process.stderr.write(`[${context}] GitHub API error\n`);
  if (httpStatus) {
    process.stderr.write(`  HTTP status: ${httpStatus}\n`);
  }
  if (stderr) {
    process.stderr.write(`  stderr: ${stderr.trim()}\n`);
  }
  if (stdout) {
    process.stderr.write(`  response body: ${stdout.trim()}\n`);
  }
  if (!stderr && !stdout) {
    process.stderr.write(`  error: ${err.message || "unknown error"}\n`);
  }
}

function postWithRetry(endpoint, payloadFile) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = ghApi(endpoint, "POST", payloadFile);
      return { success: true, response: result };
    } catch (err) {
      lastErr = err;
      const errOutput = err.stderr || err.stdout || err.message || "";
      logApiError(err, `POST ${endpoint} attempt ${attempt + 1}/${MAX_RETRIES}`);

      if (is422LineError(err)) {
        return { success: false, is422Line: true, error: errOutput };
      }

      if (!isRecoverableError(err)) {
        return { success: false, is422Line: false, error: errOutput };
      }

      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      process.stderr.write(`  Retrying in ${backoff}ms...\n`);
      sleep(backoff);
    }
  }
  return { success: false, is422Line: false, error: lastErr?.stderr || lastErr?.message || "Max retries exceeded" };
}

function submitPendingReview(endpoint, response) {
  try {
    const parsed = JSON.parse(response);
    if (parsed.state === "PENDING" && parsed.id) {
      const submitEndpoint = `${endpoint}/${parsed.id}/events`;
      const tmpFile = "/tmp/review_submit.json";
      fs.writeFileSync(tmpFile, JSON.stringify({ event: "COMMENT" }));
      const submitResult = ghApi(submitEndpoint, "POST", tmpFile);
      return submitResult;
    }
  } catch (e) {
    if (e.stderr || e.stdout) {
      logApiError(e, "submit PENDING review");
    }
  }
  return response;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 3 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: cat payload.json | node post_review.js <OWNER/REPO> <PR_NUMBER> <diff-file-path>\n\n" +
      "Reads review JSON from stdin, validates comment lines against the diff,\n" +
      "and posts the review via the GitHub API.\n"
    );
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const ownerRepo = args[0];
  const prNumber = args[1];
  const diffFilePath = path.resolve(args[2]);

  if (!fs.existsSync(diffFilePath)) {
    process.stderr.write(`Error: diff file not found: ${diffFilePath}\n`);
    process.exit(1);
  }

  let stdinData;
  try {
    stdinData = fs.readFileSync(0, "utf-8");
  } catch (e) {
    process.stderr.write(`Error reading stdin: ${e.message}\n`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(stdinData);
  } catch (e) {
    process.stderr.write(`Error parsing JSON from stdin: ${e.message}\n`);
    process.exit(1);
  }

  const diffText = fs.readFileSync(diffFilePath, "utf-8");
  const hunkMap = parseUnifiedDiff(diffText);

  const { validComments, bodyFindings } = adjustComments(payload, hunkMap);

  const adjustedPayload = {
    ...payload,
    comments: validComments,
    body: formatBodyFindings(payload.body, bodyFindings),
  };

  if (bodyFindings.length > 0) {
    process.stderr.write(`${bodyFindings.length} comment(s) moved to review body (outside diff range)\n`);
  }
  if (validComments.length !== (payload.comments || []).length - bodyFindings.length) {
    const adjusted = (payload.comments || []).length - bodyFindings.length - validComments.length;
    if (adjusted > 0) {
      process.stderr.write(`${adjusted} comment(s) had line numbers adjusted to nearest diff line\n`);
    }
  }

  const endpoint = `repos/${ownerRepo}/pulls/${prNumber}/reviews`;
  const tmpPayloadFile = "/tmp/review_payload.json";

  fs.writeFileSync(tmpPayloadFile, JSON.stringify(adjustedPayload, null, 2));
  process.stderr.write(`Posting review with ${validComments.length} inline comment(s)...\n`);

  const result = postWithRetry(endpoint, tmpPayloadFile);

  if (result.success) {
    const finalResponse = submitPendingReview(endpoint, result.response);
    console.log(finalResponse);
    process.exit(0);
  }

  if (result.is422Line) {
    process.stderr.write("Got 422 'Line could not be resolved'. Moving all comments to review body and retrying...\n");

    const fallbackPayload = buildFallbackPayload(adjustedPayload);
    fs.writeFileSync(tmpPayloadFile, JSON.stringify(fallbackPayload, null, 2));

    const fallbackResult = postWithRetry(endpoint, tmpPayloadFile);

    if (fallbackResult.success) {
      const finalResponse = submitPendingReview(endpoint, fallbackResult.response);
      console.log(finalResponse);
      process.exit(0);
    }

    process.stderr.write(`Fallback also failed: ${fallbackResult.error}\n`);
    console.log(JSON.stringify({ error: "Review posting failed after fallback", details: fallbackResult.error }));
    process.exit(1);
  }

  process.stderr.write(`Review posting failed: ${result.error}\n`);
  console.log(JSON.stringify({ error: "Review posting failed", details: result.error }));
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseUnifiedDiff,
  isLineInHunk,
  findNearestValidLine,
  adjustComments,
  formatBodyFindings,
  buildFallbackPayload,
  is422LineError,
  isRecoverableError,
  extractHttpStatus,
  logApiError,
};
