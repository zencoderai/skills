"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  redact,
  parseUnifiedDiff,
  isLineInHunk,
  findNearestValidLine,
  adjustComments,
  formatBodyFindings,
  buildFallbackPayload,
  parseApiError,
  is422LineError,
  isRecoverableError,
  extractHttpStatus,
  LineResolutionError,
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

describe("redact", () => {
  it("redacts Bearer tokens", () => {
    assert.equal(redact("Bearer ghp_abc123xyz"), "[REDACTED]");
  });

  it("redacts ghp_ PATs", () => {
    assert.equal(redact("using ghp_abc123xyz for auth"), "using [REDACTED] for auth");
  });

  it("redacts gho_ OAuth tokens", () => {
    assert.equal(redact("found gho_OAuthToken123"), "found [REDACTED]");
  });

  it("redacts ghs_ App installation tokens", () => {
    assert.equal(redact("found ghs_InstallToken456"), "found [REDACTED]");
  });

  it("redacts ghr_ refresh tokens", () => {
    assert.equal(redact("refresh ghr_RefreshToken789"), "refresh [REDACTED]");
  });

  it("redacts github_pat_ fine-grained PATs", () => {
    assert.equal(redact("pat github_pat_FineGrained123"), "pat [REDACTED]");
  });

  it("redacts Authorization headers", () => {
    assert.equal(redact("Authorization: token abc"), "[REDACTED]");
  });

  it("leaves clean text unchanged", () => {
    assert.equal(redact("normal log message"), "normal log message");
  });
});

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

  it("defaults to RIGHT side when side is omitted", () => {
    assert.equal(isLineInHunk(hunk, 17), true);  // new_start+new_count-1 = 17
    assert.equal(isLineInHunk(hunk, 18), false);
  });

  it("checks old_start/old_count for LEFT side", () => {
    // old range: 10..14 (old_start=10, old_count=5)
    assert.equal(isLineInHunk(hunk, 10, "LEFT"), true);
    assert.equal(isLineInHunk(hunk, 14, "LEFT"), true);
    assert.equal(isLineInHunk(hunk, 15, "LEFT"), false);  // one past old end
    assert.equal(isLineInHunk(hunk, 9, "LEFT"), false);
  });

  it("checks new_start/new_count for explicit RIGHT side", () => {
    assert.equal(isLineInHunk(hunk, 17, "RIGHT"), true);
    assert.equal(isLineInHunk(hunk, 18, "RIGHT"), false);
  });

  it("handles asymmetric old/new ranges on LEFT vs RIGHT", () => {
    const asymHunk = { new_start: 5, new_count: 10, old_start: 20, old_count: 3 };
    // RIGHT: 5..14
    assert.equal(isLineInHunk(asymHunk, 5, "RIGHT"), true);
    assert.equal(isLineInHunk(asymHunk, 14, "RIGHT"), true);
    assert.equal(isLineInHunk(asymHunk, 15, "RIGHT"), false);
    assert.equal(isLineInHunk(asymHunk, 20, "RIGHT"), false);
    // LEFT: 20..22
    assert.equal(isLineInHunk(asymHunk, 20, "LEFT"), true);
    assert.equal(isLineInHunk(asymHunk, 22, "LEFT"), true);
    assert.equal(isLineInHunk(asymHunk, 23, "LEFT"), false);
    assert.equal(isLineInHunk(asymHunk, 5, "LEFT"), false);
  });

  it("returns false for LEFT side on new file hunk (old_count=0)", () => {
    const newFileHunk = { new_start: 1, new_count: 10, old_start: 0, old_count: 0 };
    assert.equal(isLineInHunk(newFileHunk, 1, "LEFT"), false);
    assert.equal(isLineInHunk(newFileHunk, 0, "LEFT"), false);
    assert.equal(isLineInHunk(newFileHunk, 1, "RIGHT"), true);
  });

  it("returns false for RIGHT side on deleted file hunk (new_count=0)", () => {
    const delFileHunk = { new_start: 0, new_count: 0, old_start: 1, old_count: 5 };
    assert.equal(isLineInHunk(delFileHunk, 1, "RIGHT"), false);
    assert.equal(isLineInHunk(delFileHunk, 0, "RIGHT"), false);
    assert.equal(isLineInHunk(delFileHunk, 1, "LEFT"), true);
    assert.equal(isLineInHunk(delFileHunk, 5, "LEFT"), true);
    assert.equal(isLineInHunk(delFileHunk, 6, "LEFT"), false);
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

  it("skips zero-count hunks (pure deletions) on RIGHT side", () => {
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

  // LEFT side tests
  it("returns distance 0 for LEFT side line inside old range", () => {
    const result = findNearestValidLine(hunks, 12, "LEFT");
    assert.equal(result.line, 12);
    assert.equal(result.distance, 0);
  });

  it("snaps to old hunk start for LEFT side when line is above", () => {
    const result = findNearestValidLine(hunks, 7, "LEFT");
    assert.equal(result.line, 10);
    assert.equal(result.distance, 3);
  });

  it("snaps to old hunk end for LEFT side when line is below", () => {
    const result = findNearestValidLine(hunks, 16, "LEFT");
    assert.equal(result.line, 14);
    assert.equal(result.distance, 2);
  });

  it("uses old_count for LEFT side boundary", () => {
    const asymHunks = [{ new_start: 10, new_count: 20, old_start: 10, old_count: 3 }];
    // old range is 10..12, new range is 10..29
    // Line 15 on LEFT should snap to 12 (old end), distance 3
    const result = findNearestValidLine(asymHunks, 15, "LEFT");
    assert.equal(result.line, 12);
    assert.equal(result.distance, 3);
    // Same line on RIGHT should be inside the hunk
    const resultR = findNearestValidLine(asymHunks, 15, "RIGHT");
    assert.equal(resultR.line, 15);
    assert.equal(resultR.distance, 0);
  });

  it("finds valid line on LEFT side for deletion hunk (new_count=0)", () => {
    const deletionHunks = [{ new_start: 0, new_count: 0, old_start: 1, old_count: 5 }];
    // RIGHT returns null (new_count=0), LEFT returns the line
    assert.equal(findNearestValidLine(deletionHunks, 3, "RIGHT"), null);
    const result = findNearestValidLine(deletionHunks, 3, "LEFT");
    assert.equal(result.line, 3);
    assert.equal(result.distance, 0);
  });

  it("returns null for LEFT side on new file hunk (old_count=0)", () => {
    const newFileHunks = [{ new_start: 1, new_count: 100, old_start: 0, old_count: 0 }];
    assert.equal(findNearestValidLine(newFileHunks, 1, "LEFT"), null);
    // But RIGHT works fine
    const result = findNearestValidLine(newFileHunks, 50, "RIGHT");
    assert.equal(result.line, 50);
    assert.equal(result.distance, 0);
  });

  it("snaps LEFT side line to nearest old hunk boundary across multiple hunks", () => {
    const multiHunks = [
      { new_start: 10, new_count: 10, old_start: 10, old_count: 3 },  // old: 10..12
      { new_start: 50, new_count: 10, old_start: 30, old_count: 5 },  // old: 30..34
    ];
    // Line 20 on LEFT: closer to hunk1 end (12, dist=8) than hunk2 start (30, dist=10)
    const result = findNearestValidLine(multiHunks, 20, "LEFT");
    assert.equal(result.line, 12);
    assert.equal(result.distance, 8);
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

  it("moves comment to body for pure-deletion hunk (new_count=0) with RIGHT side", () => {
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

  it("keeps LEFT side comment on deleted file when line is in old range", () => {
    const deletionHunkMap = [
      { path: "src/old.ts", status: "deleted", hunks: [{ new_start: 0, new_count: 0, old_start: 1, old_count: 3 }] },
    ];
    const payload = {
      comments: [{ path: "src/old.ts", line: 2, side: "LEFT", body: "deleted code issue" }],
    };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, deletionHunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 0);
    assert.equal(validComments[0].line, 2);
    assert.equal(validComments[0].side, "LEFT");
  });

  it("adjusts LEFT side comment on deleted file when line is close to old range", () => {
    const deletionHunkMap = [
      { path: "src/old.ts", status: "deleted", hunks: [{ new_start: 0, new_count: 0, old_start: 1, old_count: 3 }] },
    ];
    const payload = {
      comments: [{ path: "src/old.ts", line: 5, side: "LEFT", body: "near issue" }],
    };
    // old range: 1..3, line 5 is 2 away from end (3), within MAX_LINE_DISTANCE
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, deletionHunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 1);
    assert.equal(validComments[0].line, 3);
  });

  it("moves LEFT side comment to body on new file (old_count=0)", () => {
    const newFileHunkMap = [
      { path: "src/new.ts", status: "added", hunks: [{ new_start: 1, new_count: 100, old_start: 0, old_count: 0 }] },
    ];
    const payload = {
      comments: [{ path: "src/new.ts", line: 1, side: "LEFT", body: "issue" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, newFileHunkMap);
    assert.equal(validComments.length, 0);
    assert.equal(bodyFindings.length, 1);
  });

  it("validates LEFT side comment against old range on modified file", () => {
    const modHunkMap = [
      { path: "src/mod.ts", status: "modified", hunks: [{ new_start: 10, new_count: 20, old_start: 10, old_count: 5 }] },
    ];
    // old range: 10..14, new range: 10..29
    // Line 14 on LEFT: valid (inside old range)
    const payload1 = {
      comments: [{ path: "src/mod.ts", line: 14, side: "LEFT", body: "valid left" }],
    };
    const r1 = adjustComments(payload1, modHunkMap);
    assert.equal(r1.validComments.length, 1);
    assert.equal(r1.bodyFindings.length, 0);

    // Line 20 on LEFT: outside old range (10..14), 6 away from 14 => body
    const payload2 = {
      comments: [{ path: "src/mod.ts", line: 20, side: "LEFT", body: "far left" }],
    };
    const r2 = adjustComments(payload2, modHunkMap);
    assert.equal(r2.validComments.length, 0);
    assert.equal(r2.bodyFindings.length, 1);

    // Line 20 on RIGHT: valid (inside new range 10..29)
    const payload3 = {
      comments: [{ path: "src/mod.ts", line: 20, side: "RIGHT", body: "valid right" }],
    };
    const r3 = adjustComments(payload3, modHunkMap);
    assert.equal(r3.validComments.length, 1);
    assert.equal(r3.bodyFindings.length, 0);
  });

  it("defaults to RIGHT side when side is omitted and normalizes it into the payload", () => {
    const payload = {
      comments: [{ path: "src/foo.ts", line: 12, body: "no side" }],
    };
    const { validComments, bodyFindings } = adjustComments(payload, hunkMap);
    assert.equal(validComments.length, 1);
    assert.equal(bodyFindings.length, 0);
    assert.equal(validComments[0].side, "RIGHT");
  });

  it("handles mixed LEFT and RIGHT comments in same payload", () => {
    const mixedHunkMap = [
      { path: "src/mod.ts", status: "modified", hunks: [{ new_start: 10, new_count: 5, old_start: 10, old_count: 3 }] },
    ];
    const payload = {
      comments: [
        { path: "src/mod.ts", line: 12, side: "RIGHT", body: "right valid" },   // new range 10..14 ✓
        { path: "src/mod.ts", line: 12, side: "LEFT", body: "left valid" },     // old range 10..12 ✓
        { path: "src/mod.ts", line: 14, side: "RIGHT", body: "right valid 2" }, // new range 10..14 ✓
        { path: "src/mod.ts", line: 14, side: "LEFT", body: "left invalid" },   // old range 10..12, dist=2 → adjust to 12
      ],
    };
    const { validComments, bodyFindings, adjustedCount } = adjustComments(payload, mixedHunkMap);
    assert.equal(validComments.length, 4);
    assert.equal(bodyFindings.length, 0);
    assert.equal(adjustedCount, 1);
    // The LEFT side comment at line 14 should be adjusted to 12
    const adjusted = validComments.find(c => c.side === "LEFT" && c.body.includes("left invalid"));
    assert.equal(adjusted.line, 12);
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
  it("detects 422 line resolution error from stderr", () => {
    const err = { stderr: "HTTP 422: Line could not be resolved", status: 1 };
    assert.equal(is422LineError(err), true);
  });

  it("detects 422 from JSON stdout with errors array", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Unprocessable Entity",
        errors: ["Line could not be resolved"],
        status: "422",
      }),
      stderr: "gh: Unprocessable Entity (HTTP 422)",
    };
    assert.equal(is422LineError(err), true);
  });

  it("detects 422 from JSON stdout with object errors array", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Unprocessable Entity",
        errors: [{ message: "Line could not be resolved", resource: "PullRequestReviewComment" }],
        status: "422",
      }),
      stderr: "gh: Unprocessable Entity (HTTP 422)",
    };
    assert.equal(is422LineError(err), true);
  });

  it("detects case-insensitive line could not be resolved", () => {
    const err = { stderr: "HTTP 422: LINE COULD NOT BE RESOLVED", status: 1 };
    assert.equal(is422LineError(err), true);
  });

  it("does not match unrelated 422", () => {
    const err = { stderr: "HTTP 422: Resource not found", status: 1 };
    assert.equal(is422LineError(err), false);
  });

  it("does not match unrelated 422 JSON error", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Validation Failed",
        errors: ["Resource not accessible"],
        status: "422",
      }),
      stderr: "gh: Unprocessable Entity (HTTP 422)",
    };
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

  it("does not match JSON with non-422 status even if errors contain line resolution text", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Internal Server Error",
        errors: ["Line could not be resolved"],
        status: "500",
      }),
      stderr: "gh: Internal Server Error (HTTP 500)",
    };
    assert.equal(is422LineError(err), false);
  });
});

describe("isRecoverableError", () => {
  it("treats 500+ HTTP status as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "HTTP 500 Internal Server Error", status: 1 }), true);
    assert.equal(isRecoverableError({ stderr: "HTTP 502 Bad Gateway", status: 1 }), true);
    assert.equal(isRecoverableError({ stderr: "HTTP 503 Service Unavailable", status: 1 }), true);
  });

  it("treats 500+ from JSON stdout as recoverable", () => {
    assert.equal(isRecoverableError({
      stdout: JSON.stringify({ message: "Internal Server Error", status: "500" }),
      stderr: "gh: Internal Server Error (HTTP 500)",
    }), true);
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

  it("does not treat 4xx JSON errors as recoverable", () => {
    assert.equal(isRecoverableError({
      stdout: JSON.stringify({ message: "Not Found", status: "404" }),
    }), false);
  });

  it("does not treat unknown errors as recoverable", () => {
    assert.equal(isRecoverableError({ stderr: "something broke" }), false);
  });

  it("does not treat process exit code 500 as recoverable (only HTTP status in stderr)", () => {
    assert.equal(isRecoverableError({ status: 500, stderr: "" }), false);
  });
});

describe("parseApiError", () => {
  it("joins message and errors into apiResponseMessage", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Unprocessable Entity",
        errors: ["Line could not be resolved"],
        documentation_url: "https://docs.github.com/rest/pulls/reviews",
        status: "422",
      }),
      stderr: "gh: Unprocessable Entity (HTTP 422)",
      message: "Command failed: gh api ...",
    };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 422);
    assert.equal(result.apiResponseMessage, "Unprocessable Entity: Line could not be resolved");
    assert.equal(result.jsonBody.documentation_url, "https://docs.github.com/rest/pulls/reviews");
  });

  it("joins message and multiple errors", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Validation Failed",
        errors: ["Line could not be resolved", "Path could not be resolved"],
        status: "422",
      }),
    };
    const result = parseApiError(err);
    assert.equal(result.apiResponseMessage, "Validation Failed: Line could not be resolved: Path could not be resolved");
  });

  it("uses only message when errors array is empty", () => {
    const err = { stdout: JSON.stringify({ message: "Not Found", errors: [], status: "404" }) };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 404);
    assert.equal(result.apiResponseMessage, "Not Found");
  });

  it("uses only errors when message is absent", () => {
    const err = { stdout: JSON.stringify({ errors: ["err1", "err2"], status: "400" }) };
    const result = parseApiError(err);
    assert.equal(result.apiResponseMessage, "err1: err2");
  });

  it("extracts .message from object errors", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "Line could not be resolved", resource: "PullRequestReviewComment" }],
        status: "422",
      }),
    };
    const result = parseApiError(err);
    assert.equal(result.apiResponseMessage, "Validation Failed: Line could not be resolved");
  });

  it("skips object errors without message field", () => {
    const err = {
      stdout: JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "PullRequestReviewComment" }],
        status: "422",
      }),
    };
    const result = parseApiError(err);
    assert.equal(result.apiResponseMessage, "Validation Failed");
  });

  it("parses JSON stdout with numeric status field", () => {
    const err = { stdout: JSON.stringify({ message: "Not Found", status: 404 }) };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 404);
    assert.equal(result.apiResponseMessage, "Not Found");
  });

  it("falls back to stderr regex when stdout is not JSON", () => {
    const err = { stderr: "gh: HTTP 500 Internal Server Error", stdout: "not json" };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 500);
    assert.equal(result.jsonBody, null);
    assert.ok(result.apiResponseMessage.includes("stdout: not json"));
    assert.ok(result.apiResponseMessage.includes("stderr: gh: HTTP 500"));
  });

  it("falls back to message regex when stderr has no HTTP status", () => {
    const err = { message: "HTTP 403 Forbidden", stderr: "some error" };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 403);
  });

  it("builds fallback message from all fields when no JSON", () => {
    const err = { message: "cmd failed", stdout: "raw output", stderr: "raw error" };
    const result = parseApiError(err);
    assert.ok(result.apiResponseMessage.includes("message: cmd failed"));
    assert.ok(result.apiResponseMessage.includes("stdout: raw output"));
    assert.ok(result.apiResponseMessage.includes("stderr: raw error"));
  });

  it("returns unknown error when all fields are empty", () => {
    const result = parseApiError({});
    assert.equal(result.httpStatus, null);
    assert.equal(result.apiResponseMessage, "unknown error");
    assert.equal(result.jsonBody, null);
  });

  it("handles JSON stdout with missing status field", () => {
    const err = {
      stdout: JSON.stringify({ message: "Something", errors: ["err1"] }),
      stderr: "gh: HTTP 422 Unprocessable",
    };
    const result = parseApiError(err);
    // status comes from stderr fallback since JSON has no status
    assert.equal(result.httpStatus, 422);
    // apiResponseMessage falls back because jsonBody.status was missing
    assert.ok(result.apiResponseMessage.includes("stderr:"));
  });

  it("handles JSON stdout with non-array errors field", () => {
    const err = {
      stdout: JSON.stringify({ message: "Bad", errors: "not an array", status: "400" }),
    };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 400);
    assert.equal(result.apiResponseMessage, "Bad");
  });

  it("handles JSON stdout with status 0 (falsy but present)", () => {
    const err = {
      stdout: JSON.stringify({ message: "OK", status: "0" }),
    };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 0);
    assert.equal(result.apiResponseMessage, "OK");
  });

  it("prefers JSON status over stderr regex status", () => {
    const err = {
      stdout: JSON.stringify({ message: "Unprocessable Entity", status: "422" }),
      stderr: "gh: HTTP 500 Internal Server Error",
    };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 422);
  });

  it("handles JSON stdout where status is non-numeric string", () => {
    const err = {
      stdout: JSON.stringify({ message: "Weird", status: "not-a-number" }),
      stderr: "gh: HTTP 503 Service Unavailable",
    };
    const result = parseApiError(err);
    // Non-numeric status in JSON → falls back to stderr regex
    assert.equal(result.httpStatus, 503);
  });

  it("handles JSON with no message and no errors (empty response with status)", () => {
    const err = { stdout: JSON.stringify({ status: "500" }) };
    const result = parseApiError(err);
    assert.equal(result.httpStatus, 500);
    // No message or errors → falls back to building from raw fields
    assert.ok(result.apiResponseMessage.includes("stdout:"));
  });
});

describe("extractHttpStatus", () => {
  it("extracts status from JSON stdout", () => {
    assert.equal(extractHttpStatus({
      stdout: JSON.stringify({ message: "Unprocessable Entity", status: "422" }),
      stderr: "gh: Unprocessable Entity (HTTP 422)",
    }), 422);
  });

  it("extracts status from stderr with HTTP prefix", () => {
    assert.equal(extractHttpStatus({ stderr: "gh: HTTP 422 (https://api.github.com/...)" }), 422);
  });

  it("extracts 500 status", () => {
    assert.equal(extractHttpStatus({ stderr: "HTTP 500 Internal Server Error" }), 500);
  });

  it("extracts status from message when stderr is missing", () => {
    assert.equal(extractHttpStatus({ message: "HTTP 403 Forbidden" }), 403);
  });

  it("prefers JSON stdout status over stderr regex", () => {
    assert.equal(extractHttpStatus({
      stdout: JSON.stringify({ status: "422" }),
      stderr: "HTTP 500 Internal Server Error",
    }), 422);
  });

  it("returns null when no HTTP status found", () => {
    assert.equal(extractHttpStatus({ stderr: "some random error" }), null);
  });

  it("returns null for empty error", () => {
    assert.equal(extractHttpStatus({}), null);
  });
});

describe("postWithRetry", () => {
  it("returns response on first attempt", () => {
    const apiFn = () => '{"id":1,"state":"SUBMITTED"}';
    const result = postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop);
    assert.equal(result, '{"id":1,"state":"SUBMITTED"}');
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
    assert.equal(result, '{"id":1}');
    assert.equal(calls, 3);
  });

  it("throws LineResolutionError on 422 line error without retrying", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 422");
      err.stderr = "HTTP 422: Line could not be resolved";
      throw err;
    };
    assert.throws(
      () => postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop),
      (err) => err instanceof LineResolutionError
    );
    assert.equal(calls, 1);
  });

  it("throws immediately on non-recoverable error without retrying", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 401 Unauthorized");
      err.stderr = "HTTP 401 Unauthorized";
      throw err;
    };
    assert.throws(
      () => postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop),
      /HTTP 401 Unauthorized/
    );
    assert.equal(calls, 1);
  });

  it("exhausts all retries on persistent recoverable errors and throws", () => {
    let calls = 0;
    const apiFn = () => {
      calls++;
      const err = new Error("HTTP 503 Service Unavailable");
      err.stderr = "HTTP 503 Service Unavailable";
      throw err;
    };
    assert.throws(
      () => postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, noop),
      /HTTP 503/
    );
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
    assert.throws(
      () => postWithRetry("repos/owner/repo/pulls/1/reviews", "/fake/path.json", apiFn, sleepFn)
    );
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
