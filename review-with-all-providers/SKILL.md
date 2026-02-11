---
name: review-with-all-providers
description: "Multi-provider PR review using parallel AI subagents. Use when the user provides a GitHub PR link and wants a comprehensive code review from multiple AI providers (Anthropic, OpenAI, Google). Fetches PR details, runs parallel reviews via ZencoderSubagent, merges findings, and posts selected issues as PR comments. Triggers: 'review this PR with all providers', 'multi-provider review', 'review PR with all agents', or when user shares a PR URL and asks for a thorough review."
---

# Multi-Provider PR Review

Run parallel code reviews across all available AI providers via ZencoderSubagent, merge findings, and post selected issues as GitHub PR comments.

## Workflow

### Step 1: Parse PR link

Extract owner, repo, and PR number from the user-provided URL.

```
https://github.com/<OWNER>/<REPO>/pull/<PR_NUMBER>
```

### Step 2: Fetch PR details

```bash
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json title,body,commits,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,files
```

Save the PR title, body (task description), and head SHA for later use.

### Step 3: Save the diff to the tmp file

Call following command piping output to a file in temp directory (do not call it without piping to avoid overloading context):
```bash
gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO>
```

### Step 4: Clarify requirements (if needed)

Check for any .md files in the diff that may contain requirements or design docs. If found, read their contents for context.

If the purpose of the change is unclear, use `ask_questions` to ask any clarifying questions to understand the intent behind the PR. This will help guide the review and flag deviations from intended behavior. Skip this step if the PR title + body + diffs clearly describe the intent.

### Step 5: Checkout the PR branch

```bash
git fetch origin <headRefName>
git checkout <headRefName>
git pull origin <headRefName>
```

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

Present the merged list to the user in this format:

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

### Step 8: Ask user which issues to post

Use `ask_questions` to let the user choose which findings to add as comments to the PR:

- Use one question per finding, presenting each with its number, priority, and short description.
- Each question should have options "Post comment" and "Ignore".
- Call `ask_questions` tool once with all findings, not one per question.

### Step 9: Post selected issues as PR comments

Use the GitHub reviews API to post line-specific comments for selected issues:

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
- Only include comments for issues the user selected
