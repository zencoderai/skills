"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseUnifiedDiff,
  isLineInHunk,
  findNearestValidLine,
  adjustComments,
  formatBodyFindings,
  buildFallbackPayload,
  is422LineError,
  isRecoverableError,
  extractHttpStatus,
  postWithRetry,
  submitPendingReview,
  postAndSubmit,
} = require("../../comprehensive-review/scripts/post_review.js");

const noop = () => {};

const SAMPLE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,5 +10,8 @@ some context",
  " unchanged",
  "+added line 11",
  "+added line 12",
  " unchanged",
  "-removed",
  "+replaced",
  " unchanged",
  "+new line",
  " unchanged",
].join("\n");

const MULTI_FILE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,5 +10,8 @@",
  " unchanged",
  "+added",
  "+added",
  " unchanged",
  "-removed",
  "+replaced",
  " unchanged",
  "+new line",
  " unchanged",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,3 +1,4 @@",
  " first",
  "+inserted",
  " second",
  " third",
].join("\n");

const NEW_FILE_DIFF = [
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+line one",
  "+line two",
  "+line three",
].join("\n");

const DELETED_FILE_DIFF = [
  "diff --git a/src/old.ts b/src/old.ts",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-line one",
  "-line two",
  "-line three",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses a simple diff with added, removed, and context lines", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/foo.ts");
    assert.equal(files[0].status, "modified");
    assert.equal(files[0].hunks.length, 1);

    const hunk = files[0].hunks[0];
    assert.equal(hunk.old_start, 10);
    assert.equal(hunk.old_count, 5);
    assert.equal(hunk.new_start, 10);
    assert.equal(hunk.new_count, 8);
  });

  it("parses multiple files", () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "src/foo.ts");
    assert.equal(files[1].path, "src/bar.ts");
    assert.equal(files[1].hunks[0].new_start, 1);
    assert.equal(files[1].hunks[0].new_count, 4);
  });

  it("detects new files", () => {
    const files = parseUnifiedDiff(NEW_FILE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].status, "added");
    assert.equal(files[0].path, "src/new.ts");
  });

  it("detects deleted files", () => {
    const files = parseUnifiedDiff(DELETED_FILE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].status, "deleted");
    assert.equal(files[0].path, "src/old.ts");
  });

  it("handles empty input", () => {
    const files = parseUnifiedDiff("");
    assert.deepEqual(files, []);
  });

  it("handles diff with CRLF line endings", () => {
    const crlf = SAMPLE_DIFF.replace(/\n/g, "\r\n");
    const files = parseUnifiedDiff(crlf);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/foo.ts");
  });

  it("parses hunk header without count (count defaults to 1)", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.equal(files[0].hunks[0].old_count, 1);
    assert.equal(files[0].hunks[0].new_count, 1);
  });

  it("parses multiple hunks in the same file", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,4 @@",
      " a",
      "+b",
      " c",
      " d",
      "@@ -20,3 +21,4 @@",
      " x",
      "+y",
      " z",
      " w",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.equal(files[0].hunks.length, 2);
    assert.equal(files[0].hunks[0].new_start, 1);
    assert.equal(files[0].hunks[1].new_start, 21);
  });

  it("ignores \\ No newline at end of file markers", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.equal(files[0].hunks[0].new_count, 2);
  });
});

describe("isLineInHunk", () => {
  const hunk = { new_start: 10, new_count: 8, old_start: 10, old_count: 5 };

  it("returns true for line at hunk start", () => {
    assert.equal(isLineInHunk(hunk, 10), true);
  });

  it("returns true for line inside hunk", () => {
    assert.equal(isLineInHunk(hunk, 15), true);
  });

  it("returns true for last line in hunk", () => {
    assert.equal(isLineInHunk(hunk, 17), true);
  });

  it("returns false for line just past hunk end", () => {
    assert.equal(isLineInHunk(hunk, 18), false);
  });

  it("returns false for line before hunk start", () => {
    assert.equal(isLineInHunk(hunk, 9), false);
  });

  it("returns false for line far away", () => {
    assert.equal(isLineInHunk(hunk, 100), false);
  });
});

describe("findNearestValidLine", () => {
  const hunks = [
    { new_start: 10, new_count: 5, old_start: 10, old_count: 5 },
    { new_start: 30, new_count: 3, old_start: 30, old_count: 3 },
  ];

  it("returns distance 0 for line inside a hunk", () => {
    const result = findNearestValidLine(hunks, 12);
    assert.equal(result.line, 12);
    assert.equal(result.distance, 0);
  });

  it("snaps to hunk start when line is above", () => {
    const result = findNearestValidLine(hunks, 7);
    assert.equal(result.line, 10);
    assert.equal(result.distance, 3);
  });

  it("snaps to hunk end when line is below", () => {
    const result = findNearestValidLine(hunks, 16);
    assert.equal(result.line, 14);
    assert.equal(result.distance, 2);
  });

  it("picks the nearest hunk when between two hunks", () => {
    const result = findNearestValidLine(hunks, 20);
    assert.equal(result.line, 14);
    assert.equal(result.distance, 6);
  });

  it("picks second hunk when closer", () => {
    const result = findNearestValidLine(hunks, 28);
    assert.equal(result.line, 30);
    assert.equal(result.distance, 2);
  });

  it("returns null for empty hunks", () => {
    const result = findNearestValidLine([], 10);
    assert.equal(result, null);
  });

  it("skips zero-count hunks (pure deletions)", () => {
    const deletionHunks = [{ new_start: 9, new_count: 0, old_start: 9, old_count: 3 }];
    const result = findNearestValidLine(deletionHunks, 9);
    assert.equal(result, null);
  });

  it("returns null when only zero-count hunks exist", () => {
    const result = findNearestValidLine(
      [{ new_start: 5, new_count: 0, old_start: 5, old_count: 2 }],
      4
    );
    assert.equal(result, null);
  });
});

describe("adjustComments", () => {
  const hunkMap = [
    {
      path: "src/foo.ts",
      status: "modified",
      hunks: [
        { new_start: 10, new_count: 8, old_start: 10, old_count: 5 },
      ],
    },
    {
      path: "src/bar.ts",
      status: "modified",
      hunks: [
        { new_start: 1, new_count: 4, old_start: 1, old_count: 3 },
      ],
    },
  ];

  it("keeps comment with valid line", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 12, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 0);
    assert.equal(validComments[0].line, 12);
  });

  it("adjusts comment within 5 lines of hunk start", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 7, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 1);
    assert.equal(validComments[0].line, 10);
    assert.ok(validComments[0].body.includes("Original location: line 7"));
  });

  it("adjusts comment within 5 lines of hunk end", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 19, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 1);
    assert.equal(validComments[0].line, 17);
    assert.ok(validComments[0].body.includes("Original location: line 19"));
  });

  it("moves comment to body when more than 5 lines from any hunk", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 50, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });

  it("moves comment to body when file is not in hunk map", () => {
    const payload = {
      comments: [{ path: "src/unknown.ts", line: 5, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });

  it("handles multiple comments with mixed validity", () => {
    const payload = {
      comments: [
        { path: "src/foo.ts", line: 12, side: "RIGHT", body: "valid" },
        { path: "src/foo.ts", line: 50, side: "RIGHT", body: "too far" },
        { path: "src/bar.ts", line: 2, side: "RIGHT", body: "valid bar" },
        { path: "src/unknown.ts", line: 1, side: "RIGHT", body: "no file" },
      ],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 2);
    assert.equal(bodyFindings.length, 2);
  });

  it("does not add adjustment note when line is already valid", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 15, side: "RIGHT", body: "ok" }],
    };
    const { validComments } = adjustComments(payload, hunkMap);
    assert.equal(validComments[0].body, "ok");
  });

  it("handles empty comments array", () => {
    const payload = { comments: [] };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 0);
  });

  it("handles missing comments property", () => {
    const payload = {};
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 0);
  });

  it("adjusts comment exactly 5 lines above hunk start", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 5, side: "RIGHT", body: "edge" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(validComments[0].line, 10);
  });

  it("moves comment exactly 6 lines above hunk start to body", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 4, side: "RIGHT", body: "too far" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });

  it("moves comment to body when file has empty hunks", () => {
    const emptyHunkMap = [{ path: "src/empty.ts", status: "modified", hunks: [] }];
    const payload = {
      comments: [{ path: "src/empty.ts", line: 5, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, emptyHunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });

  it("moves comment to body for pure-deletion hunk (new_count=0)", () => {
    const deletionHunkMap = [
      { path: "src/old.ts", status: "deleted", hunks: [{ new_start: 0, new_count: 0, old_start: 1, old_count: 3 }] },
    ];
    const payload = {
      comments: [{ path: "src/old.ts", line: 1, side: "RIGHT", body: "issue" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, deletionHunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });
});

describe("formatBodyFindings", () => {
  it("returns existing body when no findings", () => {
    assert.equal(formatBodyFindings("hello", []), "hello");
  });

  it("appends findings to body", () => {
    const result = formatBodyFindings("body", [
      { path: "a.ts", line: 5, body: "issue desc" },
    ]);
    assert.ok(result.includes("body"));
    assert.ok(result.includes("Findings outside diff range"));
    assert.ok(result.includes("a.ts:5"));
    assert.ok(result.includes("issue desc"));
  });

  it("handles empty existing body", () => {
    const result = formatBodyFindings("", [
      { path: "b.ts", line: 1, body: "x" },
    ]);
    assert.ok(result.includes("b.ts:1"));
  });
});

describe("buildFallbackPayload", () => {
  it("moves all comments into body", () => {
    const payload = {
      event: "COMMENT",
      body: "Review",
      comments: [
        { path: "a.ts", line: 10, body: "finding 1" },
        { path: "b.ts", line: 20, body: "finding 2" },
      ],
    };
    const fallback = buildFallbackPayload(payload);
    assert.deepEqual(fallback.comments, []);
    assert.equal(fallback.event, "COMMENT");
    assert.ok(fallback.body.includes("a.ts:10"));
    assert.ok(fallback.body.includes("b.ts:20"));
    assert.ok(fallback.body.includes("finding 1"));
    assert.ok(fallback.body.includes("finding 2"));
  });

  it("handles empty comments", () => {
    const payload = { event: "COMMENT", body: "Review", comments: [] };
    const fallback = buildFallbackPayload(payload);
    assert.deepEqual(fallback.comments, []);
    assert.equal(fallback.body, "Review");
  });

  it("defaults event to COMMENT", () => {
    const fallback = buildFallbackPayload({ body: "x", comments: [] });
    assert.equal(fallback.event, "COMMENT");
  });
});

describe("is422LineError", () => {
  it("detects 422 line resolution error", () => {
    const err = { stderr: "HTTP 422: Line could not be resolved", status: 1 };
    assert.equal(is422LineError(err), true);
  });

  it("detects pull_review_comment variant", () => {
    const err = { stderr: "422 Validation Failed - pull_review_comment line", status: 1 };
    assert.equal(is422LineError(err), true);
  });

  it("does not match unrelated 422", () => {
    const err = { stderr: "HTTP 422: Resource not found", status: 1 };
    assert.equal(is422LineError(err), false);
  });

  it("does not match non-422 errors", () => {
    const err = { stderr: "HTTP 500: Internal Server Error", status: 1 };
    assert.equal(is422LineError(err), false);
  });

  it("does not match 500 errors containing line resolution keywords", () => {
    const err = { stderr: "HTTP 500: proxy timeout, line could not be resolved upstream", status: 1 };
    assert.equal(is422LineError(err), false);
  });

  it("does not match when exit code contains digit 1 but HTTP status is not 422", () => {
    const err = { stderr: "HTTP 201: pull_review_comment line created", status: 1 };
    assert.equal(is422LineError(err), false);
  });
});

describe("isRecoverableError", () => {
  it("treats 500+ HTTP status as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "HTTP 500 Internal Server Error", status: 1 }), true);
    assert.equal(isRecoverableError({ stderr: "HTTP 502 Bad Gateway", status: 1 }), true);
    assert.equal(isRecoverableError({ stderr: "HTTP 503 Service Unavailable", status: 1 }), true);
  });

  it("treats network errors as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "ECONNRESET" }), true);
    assert.equal(isRecoverableError({ stderr: "ETIMEDOUT" }), true);
    assert.equal(isRecoverableError({ stderr: "ECONNREFUSED" }), true);
    assert.equal(isRecoverableError({ message: "socket hang up" }), true);
  });

  it("does not treat 4xx as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "HTTP 404 not found", status: 1 }), false);
    assert.equal(isRecoverableError({ stderr: "HTTP 422 validation", status: 1 }), false);
  });

  it("does not treat unknown errors as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "something broke" }), false);
  });

  it("does not treat process exit code 500 as recoverable (only HTTP status in stderr)", () => {
    assert.equal(isRecoverableError({ status: 500, stderr: "" }), false);
  });
});

describe("extractHttpStatus", () => {
  it("extracts status from stderr with HTTP prefix", () => {
    assert.equal(extractHttpStatus({ stderr: "gh: HTTP 422 (https://api.github.com/...)" }), 422);
  });

  it("extracts 500 status", () => {
    assert.equal(extractHttpStatus({ stderr: "HTTP 500 Internal Server Error" }), 500);
  });

  it("extracts status from message when stderr is missing", () => {
    assert.equal(extractHttpStatus({ message: "HTTP 403 Forbidden" }), 403);
  });

  it("returns null when no HTTP status found", () => {
    assert.equal(extractHttpStatus({ stderr: "some random error" }), null);
  });

  it("returns null for empty error", () => {
    assert.equal(extractHttpStatus({}), null);
  });
});

describe("postWithRetry", () => {
  it("returns success on first attempt", () => {
    const apiFn = () => '{"id":1,"state":"SUBMITTED"}';
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result.success, true);
    assert.equal(result.response, '{"id":1,"state":"SUBMITTED"}');
  });

  it("retries on recoverable error and succeeds on third attempt", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      if (calls < 3) {
        const err = new Error("HTTP 503 Service Unavailable");
        err.stderr = "HTTP 503 Service Unavailable";
        throw err;
      }
      return '{"id":1}';
    };
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result.success, true);
    assert.equal(calls, 3);
  });

  it("returns is422Line:true on first attempt without retrying", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 422");
      err.stderr = "HTTP 422: Line could not be resolved";
      throw err;
    };
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result.success, false);
    assert.equal(result.is422Line, true);
    assert.equal(calls, 1);
  });

  it("returns failure immediately on non-recoverable error without retrying", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 401 Unauthorized");
      err.stderr = "HTTP 401 Unauthorized";
      throw err;
    };
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result.success, false);
    assert.equal(result.is422Line, false);
    assert.equal(calls, 1);
  });

  it("exhausts all retries on persistent recoverable errors", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 503 Service Unavailable");
      err.stderr = "HTTP 503 Service Unavailable";
      throw err;
    };
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result.success, false);
    assert.equal(result.is422Line, false);
    assert.equal(calls, 5);
  });

  it("does not sleep after the final retry attempt", () => {
    let sleepCalls = 0;
    const apiFn = () => {
      const err = new Error("HTTP 503");
      err.stderr = "HTTP 503 Service Unavailable";
      throw err;
    };
    const sleepFn = () => { sleepCalls++; };
    postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, sleepFn);
    assert.equal(sleepCalls, 4);
  });
});

describe("submitPendingReview", () => {
  it("returns response unchanged when state is not PENDING", () => {
    let called = false;
    const apiFn = () => { called = true; return "{}"; };
    const result = submitPendingReview("endpoint", '{"id":42,"state":"SUBMITTED"}', apiFn);
    assert.equal(called, false);
    assert.equal(result, '{"id":42,"state":"SUBMITTED"}');
  });

  it("submits PENDING review and returns submit API response", () => {
    let submittedEndpoint;
    const apiFn = (ep) => { submittedEndpoint = ep; return '{"state":"SUBMITTED"}'; };
    const result = submitPendingReview(
      "repos/owner/repo/pulls/1/reviews",
      '{"id":99,"state":"PENDING"}',
      apiFn
    );
    assert.ok(submittedEndpoint.includes("99/events"));
    assert.equal(result, '{"state":"SUBMITTED"}');
  });

  it("throws when PENDING submit API call fails", () => {
    const apiFn = () => {
      const err = new Error("HTTP 403 Forbidden");
      err.stderr = "HTTP 403 Forbidden";
      throw err;
    };
    assert.throws(
      () => submitPendingReview("repos/owner/repo/pulls/1/reviews", '{"id":99,"state":"PENDING"}', apiFn),
      /HTTP 403/
    );
  });

  it("returns original response when JSON parse fails", () => {
    const apiFn = () => "{}";
    const result = submitPendingReview("endpoint", "not-json", apiFn);
    assert.equal(result, "not-json");
  });

  it("returns response unchanged when id is missing", () => {
    let called = false;
    const apiFn = () => { called = true; return "{}"; };
    const result = submitPendingReview("endpoint", '{"state":"PENDING"}', apiFn);
    assert.equal(called, false);
    assert.equal(result, '{"state":"PENDING"}');
  });
});

describe("postAndSubmit", () => {
  it("returns API response on success", () => {
    const apiFn = () => '{"id":1,"state":"SUBMITTED"}';
    const result = postAndSubmit("endpoint", "/fake/path.json", { comments: [] }, apiFn, noop);
    assert.equal(result, '{"id":1,"state":"SUBMITTED"}');
  });

  it("falls back to body-only on 422 line error and succeeds", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      if (calls === 1) {
        const err = new Error("HTTP 422");
        err.stderr = "HTTP 422: Line could not be resolved";
        throw err;
      }
      return '{"id":2,"state":"SUBMITTED"}';
    };
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmpFile = path.join(os.tmpdir(), `test_payload_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ event: "COMMENT", body: "body", comments: [{ path: "f.ts", line: 1, body: "x" }] }));
    try {
      const result = postAndSubmit(
        "endpoint",
        tmpFile,
        { event: "COMMENT", body: "body", comments: [{ path: "f.ts", line: 1, body: "x" }] },
        apiFn,
        noop
      );
      assert.equal(calls, 2);
      assert.equal(result, '{"id":2,"state":"SUBMITTED"}');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });

  it("throws when initial post fails with non-422 error", () => {
    const apiFn = () => {
      const err = new Error("HTTP 401 Unauthorized");
      err.stderr = "HTTP 401 Unauthorized";
      throw err;
    };
    assert.throws(
      () => postAndSubmit("endpoint", "/fake/path.json", { comments: [] }, apiFn, noop),
      /Review posting failed/
    );
  });

  it("throws when fallback also fails after 422", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = calls === 1
        ? Object.assign(new Error("HTTP 422"), { stderr: "HTTP 422: Line could not be resolved" })
        : Object.assign(new Error("HTTP 500"), { stderr: "HTTP 500 Internal Server Error" });
      throw err;
    };
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmpFile = path.join(os.tmpdir(), `test_payload_fallback_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ event: "COMMENT", body: "body", comments: [] }));
    try {
      assert.throws(
        () => postAndSubmit("endpoint", tmpFile, { event: "COMMENT", body: "body", comments: [] }, apiFn, noop),
        /Review posting failed after fallback/
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });
});
