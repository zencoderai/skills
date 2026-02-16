---
name: comprehensive-review
description: "Multi-provider code review using parallel AI subagents. Use when the user wants a comprehensive code review from multiple AI providers (Anthropic, OpenAI, Google). Works with GitHub PR links OR local branch changes. If a PR URL is provided, fetches PR details and can post comments. If no PR is provided, reviews the diff between the current branch and its base branch plus any uncommitted changes. Triggers: 'review this PR with all providers', 'multi-provider review', 'review with all agents', 'review my changes with all providers', or when user shares a PR URL and asks for a thorough review."
disable-model-invocation: true
---

# Multi-Provider Code Review

Run parallel code reviews across all available AI providers via ZencoderSubagent, merge findings, and let the user act on them. Works with both GitHub PRs and local branch diffs.

## Workflow

### Step 1: Determine review mode

Check if the user provided a GitHub PR link.

- **PR mode**: A PR URL is provided matching `https://github.com/<OWNER>/<REPO>/pull/<PR_NUMBER>`. Extract owner, repo, and PR number.
- **Local mode**: No PR URL provided. The review will be based on the diff between the current branch and its base branch, plus any uncommitted changes.

### Step 2: Gather change details

#### PR mode

```bash
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json title,body,commits,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,files
```

Save the PR title, body (task description), and head SHA for later use.

#### Local mode

Detect the current branch and its merge base:

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH=$(git log --oneline --merges --ancestry-path HEAD..$(git remote show origin | grep 'HEAD branch' | awk '{print $NF}') 2>/dev/null | tail -1 | cut -d' ' -f1 || echo "main")
```

If detecting the base branch fails, try common defaults (`main`, `master`, `develop`). Use `ask_questions` to confirm the base branch if unsure.

### Step 3: Save the diff to a tmp file

Call the following command piping output to a file in temp directory (do not call it without piping to avoid overloading context):

#### PR mode

```bash
gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO> > /tmp/review-diff-{branch-name}.patch
```

#### Local mode

Generate a combined diff of committed branch changes plus uncommitted changes:

```bash
MERGE_BASE=$(git merge-base HEAD origin/<BASE_BRANCH>)
git diff $MERGE_BASE HEAD > /tmp/review-diff-committed-{branch-name}.patch
git diff > /tmp/review-diff-uncommitted-{branch-name}.patch
cat /tmp/review-diff-committed-{branch-name}.patch /tmp/review-diff-uncommitted-{branch-name}.patch > /tmp/review-diff-{branch-name}.patch
```

### Step 4: Clarify requirements (if needed)

Check for any .md files in the diff that may contain requirements or design docs. If found, read their contents for context.

If the purpose of the change is unclear, use `ask_questions` to ask any clarifying questions to understand the intent. This will help guide the review and flag deviations from intended behavior. Skip this step if the context (PR title + body or diffs) clearly describes the intent.

### Step 5: Checkout the correct branch

#### PR mode

```bash
git fetch origin <headRefName>
git checkout <headRefName>
git pull origin <headRefName>
```

#### Local mode

No checkout needed — already on the working branch.

### Step 6: Run parallel reviews with all providers

Launch one ZencoderSubagent per provider in parallel. Use only providers that support `hard` complexity.

For each provider, call `ZencoderSubagent` with:
- **provider**: the provider name
- **complexity**: `"hard"`
- **prompt**: Construct as follows:

```
Use the code-review skill to review the following change.

## <title>

### Description
<PR body / task description>

### Diff
<link to file containing the diff>
```

### Step 7: Merge results

Compile all findings from all providers into a single deduplicated list:

1. Collect all findings from each provider's response.
2. Group findings by file and line number.
3. Merge issues that describe the same problem (same file, similar line range, same category). When merging, note which providers flagged it — issues found by multiple providers are higher confidence.
4. Keep the best description and suggested fix from among duplicates.
5. Sort by priority (P0 first), then by file path.
6. Filter put any false positives (if subagent itself said that it's not a real issue or you're 100% sure it's not a real issue).

```
## Merged Review Findings

| # | Priority | Issue | File:Line | Flagged By |
|---|----------|-------|-----------|------------|
| 1 | P0 | Description | path:line | anthropic, openai |
| 2 | P1 | Description | path:line | google |
| ... | | | | |

### Details

#### 1. [P0] Issue title
**File:** `path/to/file:line`
**Flagged by:** anthropic, openai

Description and why it matters.

**Suggested fix:**
\`\`\`
code
\`\`\`
```

### Step 8: Ask user how to handle each finding

Use `ask_questions` to let the user decide what to do with each finding:

- Use one question per finding, presenting each with its number, priority, and short description.
- **PR mode options**: "Fix", "Post comment", "Ignore"
- **Local mode options**: "Fix", "Ignore"
- Call `ask_questions` tool once with all findings, not one per question.

### Step 9: Apply fixes for issues marked "Fix"

For each finding the user chose "Fix":

1. Read the relevant file and understand the surrounding context.
2. Apply the suggested fix (or an appropriate fix if the suggestion is incomplete).
3. After all fixes are applied, present a summary of changes made.

### Step 10: Post selected issues as PR comments (PR mode only)

**Skip this step entirely if no findings were marked "Post comment".**

Only applies in PR mode. Use the GitHub reviews API to post line-specific comments for selected issues:

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews \
  --method POST \
  -f event='COMMENT' \
  -f body='## Multi-Provider Code Review

### Findings Summary

| Priority | Issue | Location | Flagged By |
|----------|-------|----------|------------|
| P0 | ... | file:line | providers |

### Recommendation
[Concise recommendation]' \
  --input - << 'EOF'
{
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**[P0] Issue Title** (flagged by: anthropic, openai)\n\nDescription.\n\n**Suggested fix:**\n```\ncode\n```"
    }
  ]
}
EOF
```

Requirements for the API call:
- Use `/pulls/{PR}/reviews` endpoint (NOT `/pulls/{PR}/comments`)
- `event` must be `COMMENT`
- `line` = line number in the NEW version of file (from the diff's `+` side)
- `side` = `RIGHT` for new/modified code, `LEFT` for deleted code
- `path` = relative to repo root
- Only include comments for issues the user selected as "Post comment"
