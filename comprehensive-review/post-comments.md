# Post PR Comments Subagent

Post review findings as inline PR comments using the GitHub Reviews API.

## Inputs

You will receive:
- **Owner**: GitHub repository owner
- **Repo**: GitHub repository name
- **PR Number**: The pull request number
- **Diff file path**: Absolute path to the saved diff file
- **Findings**: A list of findings to post, each with priority, title, description, file, line, review type, suggested fix

## Non-negotiable execution rules

- You may call `POST /pulls/{PR}/reviews` at most **2 times total**: the initial attempt and one fallback.
- Do NOT make probe, diagnostic, subset, or single-finding review posts.
- Do NOT use the live PR to test whether individual lines are accepted.
- Every API call creates permanent, visible comments — treat each call as irreversible.
- After any successful 2xx review creation, stop immediately. Do NOT make verification calls.

## Workflow

### Step 1: Generate hunk map from the diff file

Generate a JSON hunk map that records the exact changed line ranges for each file. Do NOT read the full diff file yourself — use the provided script instead:

```bash
node <SKILL_DIRECTORY>/scripts/diff_changed_ranges.js <diff-file-path>
```

Where `<SKILL_DIRECTORY>` is the directory containing `post-comments.md` (the file you are reading right now). The script outputs JSON to stdout.

Save the output and verify it is valid JSON. If the script fails, report the error.

### Step 2: Validate comment placement using the hunk map

The hunk map is a small JSON with this structure:

```json
{
  "files": [
    {
      "path": "src/foo.ts",
      "status": "modified",
      "hunks": [
        { "old_start": 10, "old_count": 5, "new_start": 10, "new_count": 8, "added_lines": [12, 13, 15] }
      ]
    }
  ]
}
```

For each finding, determine whether the finding's file and line fall within a diff hunk:

1. Find the file entry in the hunk map whose `path` matches the finding's file.
2. A line number `L` is **valid for inline commenting** if it appears in the `added_lines` array of any hunk for that file. Prefer targeting actually added/modified lines over context lines within the hunk range. If `added_lines` is available, use it as the authoritative source; otherwise fall back to checking `new_start <= L < new_start + new_count`.
3. For each finding:
   - If the line **is valid**: add it as an inline comment using `"path": "<file>", "line": <L>, "side": "RIGHT"`.
   - If the line **is NOT valid** (file not in hunk map, or line outside all hunks for that file):
     - First, try the **same file**: pick the `new_start` of the hunk closest to the finding's line.
     - If the file is not in the hunk map at all: pick the first changed line (`new_start` of the first hunk) of the most contextually related file (e.g., a file that imports or calls the affected code).
     - Prefix the comment body with: `"⚠️ This comment is about [<original_file>:<original_line>] which is outside the diff. The issue described below applies there:\n\n"` followed by the full finding details.
4. **Do NOT silently drop findings** and do NOT fall back to the review body text.
5. **Do NOT merge separate findings** into a single comment unless they refer to the exact same file and line. Each finding must produce its own visible inline comment.

### Step 3: Construct the review payload

Build a single JSON file containing the full review payload. **Do NOT mix `-f` flags with `--input`** — all fields must be in one JSON body.

```bash
cat > /tmp/review_payload.json << 'REVIEW_EOF'
{
  "event": "COMMENT",
  "body": "## Comprehensive Code Review\n\n### Findings Summary\n\n| Priority | Issue | Location | Review type |\n|----------|-------|----------|------------|\n| P0 | Issue title | `path/to/file.ts:42` | code-quality(gpt-5-3-codex) |\n\n### Recommendation\n[Concise recommendation]",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**[P0] Issue Title** (review type: code-quality(gpt-5-3-codex))\n\nDescription.\n\n**Suggested fix:**\n```\ncode\n```"
    }
  ]
}
REVIEW_EOF
```

### Step 4: Post the review

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews \
  --method POST --input /tmp/review_payload.json
```

### Step 5: Verify and submit if needed

Check the response from the API call:

- If the response contains `"state": "COMMENTED"` — the review is posted and visible. Done.
- If the response contains `"state": "PENDING"` — the review was created but not submitted. Extract the review `id` from the response and submit it:
  ```bash
  gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews/<REVIEW_ID>/events \
    --method POST --input - <<< '{"event": "COMMENT"}'
  ```

**Do NOT make additional verification API calls** after a successful response. A 2xx with a review ID means the review was created. Only submit if the state is PENDING.

### Error handling: "Line could not be resolved" (422)

If the API returns HTTP 422 with `"Line could not be resolved"`:

1. Do **NOT** make any additional API calls to identify which comment failed.
2. Do **NOT** test findings individually or in subsets.
3. Move **ALL** findings from `comments` into the review `body` with full details (priority, description, file:line reference, suggested fix).
4. Set `comments` to `[]`.
5. Post the rebuilt payload exactly once.

You are allowed exactly **one** initial attempt and **one** fallback. Never make 3+ API calls to the reviews endpoint.

## Requirements for the API call

- Use `/pulls/{PR}/reviews` endpoint (NOT `/pulls/{PR}/comments`)
- `event` must be `COMMENT` (set inside the JSON body, NOT via `-f` flag)
- `line` = line number in the NEW version of file — must be within a diff hunk's `new_start` to `new_start + new_count` range
- `side` = `RIGHT` for new/modified code, `LEFT` for deleted code
- `path` = relative to repo root
- Include the review type with model name (e.g., `code-quality(gpt-5-3-codex)`, `security(opus-4-6-think)`) in each comment
- Each finding gets its own comment — do NOT merge multiple findings into one comment even if they are on nearby lines

## Required Output

Return the result of the API call. If the API call fails, return the error message and suggest possible fixes.
