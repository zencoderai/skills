#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_LINE_DISTANCE = 5;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

const REDACT_PATTERNS = [/Bearer\s+\S+/gi, /token\s+\S+/gi, /ghp_\S+/gi, /Authorization:[^\n]*/gi];

function redact(text) {
  return REDACT_PATTERNS.reduce((s, re) => s.replace(re, "[REDACTED]"), text);
}

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
      };
      newLineNum = currentHunk.new_start;
      currentHunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        newLineNum++;
      } else if (line.startsWith("-")) {
        // deleted line
      } else if (line.startsWith("\\")) {
        // special diff indicator (e.g. "\ No newline at end of file") — skip
      } else {
        newLineNum++;
      }
    }
  }

  flush();
  return files;
}

function isLineInHunk(hunk, line, side) {
  if (side === "LEFT") {
    return line >= hunk.old_start && line < hunk.old_start + hunk.old_count;
  }
  return line >= hunk.new_start && line < hunk.new_start + hunk.new_count;
}

function findNearestValidLine(hunks, line, side) {
  let bestLine = null;
  let bestDist = Infinity;

  for (const hunk of hunks) {
    const count = side === "LEFT" ? hunk.old_count : hunk.new_count;
    const start = side === "LEFT" ? hunk.old_start : hunk.new_start;
    if (count === 0) continue;

    const hunkStart = start;
    const hunkEnd = start + count - 1;

    if (isLineInHunk(hunk, line, side)) {
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
  let adjustedCount = 0;

  for (const comment of payload.comments || []) {
    const fileEntry = fileMap.get(comment.path);

    if (!fileEntry || fileEntry.hunks.length === 0) {
      bodyFindings.push(comment);
      continue;
    }

    const side = comment.side || "RIGHT";
    const nearest = findNearestValidLine(fileEntry.hunks, comment.line, side);

    if (!nearest) {
      bodyFindings.push(comment);
      continue;
    }

    if (nearest.distance === 0) {
      validComments.push(comment);
    } else if (nearest.distance <= MAX_LINE_DISTANCE) {
      adjustedCount++;
      validComments.push({
        ...comment,
        line: nearest.line,
        body: `> _Original location: line ${comment.line} (adjusted to nearest diff line)_\n\n${comment.body}`,
      });
    } else {
      bodyFindings.push(comment);
    }
  }

  return { validComments, bodyFindings, adjustedCount };
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

function extractHttpStatus(err) {
  const text = err.stderr || err.message || "";
  const match = text.match(/HTTP (\d{3})/i);
  return match ? parseInt(match[1], 10) : null;
}

function isRecoverableError(err) {
  const msg = (err.stderr || err.message || "").toLowerCase();
  const httpStatus = extractHttpStatus(err);
  if (httpStatus !== null && httpStatus >= 500) return true;
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("econnrefused")) return true;
  if (msg.includes("socket hang up") || msg.includes("network")) return true;
  return false;
}

function is422LineError(err) {
  const output = err.stderr || err.stdout || err.message || "";
  const httpStatus = extractHttpStatus(err);
  return (output.includes("422") || httpStatus === 422) &&
    output.toLowerCase().includes("line") &&
    (output.toLowerCase().includes("could not be resolved") || output.toLowerCase().includes("pull_review_comment"));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function logApiError(err, context) {
  const httpStatus = extractHttpStatus(err);
  const stderr = redact(err.stderr || "");
  const stdout = redact(err.stdout || "");
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

function postWithRetry(endpoint, payloadFile, _api, _sleep) {
  _api = _api || ghApi;
  _sleep = _sleep || sleep;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = _api(endpoint, "POST", payloadFile);
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

      if (attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        process.stderr.write(`  Retrying in ${backoff}ms...\n`);
        _sleep(backoff);
      }
    }
  }
  return { success: false, is422Line: false, error: lastErr?.stderr || lastErr?.message || "Max retries exceeded" };
}

function submitPendingReview(endpoint, response, _api) {
  _api = _api || ghApi;
  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch (_) {
    return response;
  }

  if (parsed.state !== "PENDING" || !parsed.id) {
    return response;
  }

  const submitEndpoint = `${endpoint}/${parsed.id}/events`;
  const tmpFile = path.join(os.tmpdir(), `review_submit_${crypto.randomBytes(6).toString("hex")}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ event: "COMMENT" }));
    return _api(submitEndpoint, "POST", tmpFile);
  } catch (e) {
    logApiError(e, "submit PENDING review");
    process.stderr.write("Error: failed to submit PENDING review — review may not be visible\n");
    throw e;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function parseArgs(args) {
  if (args.length < 4 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: node post_review.js <OWNER/REPO> <PR_NUMBER> <diff-file-path> <payload-file-path>\n\n" +
      "Reads review JSON from the payload file, validates comment lines against the diff,\n" +
      "and posts the review via the GitHub API. Rewrites the payload file if needed.\n"
    );
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const ownerRepo = args[0];
  const prNumber = args[1];

  if (!/^[\w.-]+\/[\w.-]+$/.test(ownerRepo)) {
    process.stderr.write(`Error: invalid OWNER/REPO format: ${ownerRepo}\n`);
    process.exit(1);
  }

  if (!/^\d+$/.test(prNumber)) {
    process.stderr.write(`Error: PR_NUMBER must be a positive integer: ${prNumber}\n`);
    process.exit(1);
  }

  const diffFilePath = path.resolve(args[2]);
  const payloadFilePath = path.resolve(args[3]);

  if (!fs.existsSync(diffFilePath)) {
    process.stderr.write(`Error: diff file not found: ${diffFilePath}\n`);
    process.exit(1);
  }

  if (!fs.existsSync(payloadFilePath)) {
    process.stderr.write(`Error: payload file not found: ${payloadFilePath}\n`);
    process.exit(1);
  }

  return { ownerRepo, prNumber, diffFilePath, payloadFilePath };
}

function readPayload(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    process.stderr.write(`Error reading payload file: ${e.message}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Error parsing payload JSON: ${e.message}\n`);
    process.exit(1);
  }
}

function postAndSubmit(endpoint, payloadFilePath, adjustedPayload, _api, _sleep) {
  const result = postWithRetry(endpoint, payloadFilePath, _api, _sleep);

  if (result.success) {
    return submitPendingReview(endpoint, result.response, _api);
  }

  if (result.is422Line) {
    process.stderr.write("Got 422 'Line could not be resolved'. Moving all comments to review body and retrying...\n");
    const fallbackPayload = buildFallbackPayload(adjustedPayload);
    fs.writeFileSync(payloadFilePath, JSON.stringify(fallbackPayload, null, 2));

    const fallbackResult = postWithRetry(endpoint, payloadFilePath, _api, _sleep);
    if (fallbackResult.success) {
      return submitPendingReview(endpoint, fallbackResult.response, _api);
    }

    const fallbackErr = new Error("Review posting failed after fallback");
    fallbackErr.details = fallbackResult.error;
    throw fallbackErr;
  }

  const err = new Error("Review posting failed");
  err.details = result.error;
  throw err;
}

function main() {
  const { ownerRepo, prNumber, diffFilePath, payloadFilePath } = parseArgs(process.argv.slice(2));
  const payload = readPayload(payloadFilePath);
  const diffText = fs.readFileSync(diffFilePath, "utf-8");
  const hunkMap = parseUnifiedDiff(diffText);

  const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, hunkMap);

  const adjustedPayload = {
    ...payload,
    comments: validComments,
    body: formatBodyFindings(payload.body, bodyFindings),
  };

  if (bodyFindings.length > 0) {
    console.log(`${bodyFindings.length} comment(s) moved to review body (outside diff range)`);
  }
  if (adjustedCount > 0) {
    console.log(`${adjustedCount} comment(s) had line numbers adjusted to nearest diff line`);
  }

  fs.writeFileSync(payloadFilePath, JSON.stringify(adjustedPayload, null, 2));

  const endpoint = `repos/${ownerRepo}/pulls/${prNumber}/reviews`;
  console.log(`Posting review with ${validComments.length} inline comment(s)...`);

  try {
    const finalResponse = postAndSubmit(endpoint, payloadFilePath, adjustedPayload);
    console.log(finalResponse);
    console.log("Review posted successfully");
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, details: e.details || e.message }));
    console.error("Review posting failed");
    process.exit(1);
  }
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
  postWithRetry,
  submitPendingReview,
  postAndSubmit,
};
