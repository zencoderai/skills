---
name: comprehensive-review
description: "Comprehensive code review using parallel specialized subagents. Use when the user wants a thorough code review covering architecture, security, performance, code quality, and correctness. Works with GitHub PR links OR local branch changes. If a PR URL is provided, fetches PR details and can post comments. If no PR is provided, reviews the diff between the current branch and its base branch plus any uncommitted changes. Triggers: 'comprehensive review', 'full code review', 'review this PR thoroughly', 'review my changes', or when user shares a PR URL and asks for a thorough review."
disable-model-invocation: true
metadata:
  version: 1.0.0
---

# Comprehensive Code Review

Run parallel specialized code reviews via subagents, covering architecture, security, performance, code quality, and correctness. Merge findings and let the user act on them. Works with both GitHub PRs and local branch diffs.

## Workflow

### Step 1: Determine review mode

Check if the user provided a GitHub PR link.

- **PR mode**: A PR URL is provided matching `https://github.com/<OWNER>/<REPO>/pull/<PR_NUMBER>`. Extract owner, repo, and PR number.
- **Local mode**: No PR URL provided. The review will be based on the diff between the current branch and its base branch, plus any uncommitted changes.

### Step 2: Fetch diff and task description via subagent

Call a subagent to gather all change details, save the diff, and checkout the correct branch.

**IMPORTANT**: Do NOT read the file `<SKILL_DIRECTORY>/fetch-diff.md` yourself. The subagent must read it.

Construct the subagent prompt as follows:

```
Read the file `<SKILL_DIRECTORY>/fetch-diff.md` for detailed instructions, then follow them.

Review mode: <PR mode or Local mode>
<If PR mode: Owner: <OWNER>, Repo: <REPO>, PR Number: <PR_NUMBER>>
```

If available use `ZencoderSubagent` tool. Use provider=anthropic and highest complexity if complexity and provider options are available.
If `ZencoderSubagent` is not available, use any other tool to run subagent or task. Use most capable model available.

The subagent will return:
- **Diff file path**: path to the saved diff file
- **Title**: the PR title or summary from commits
- **Description**: comprehensive task description with all requirements

Save these values for use in subsequent steps.

### Step 3: Clarify requirements (if needed)

If the purpose of the change is unclear from the title and description returned by the subagent, ask any clarifying questions to understand the intent. This will help guide the review and flag deviations from intended behavior. Use tool to ask questions if available. Skip this step if the context clearly describes the intent.

### Step 4: Run parallel specialized reviews

Launch **5 parallel subagent calls**, one for each review type. Each subagent focuses on a specific aspect of code quality.

#### Review Criteria and Instruction Files

Each review criterion has a corresponding instruction file inside this skill's directory:

| Review criterion | Instruction File |
|-------------|-----------------|
| architecture | `criteria/architecture.md` |
| security | `criteria/security.md` |
| performance | `criteria/performance.md` |
| code-quality | `criteria/code-quality.md` |
| correctness | `criteria/correctness.md` |

**IMPORTANT**: Do NOT read these instruction files yourself. Each subagent must read its own instruction file.

#### Subagent Calls

If available use `ZencoderSubagent` tool. Use provider=anthropic and highest complexity if complexity and provider options are available.
If `ZencoderSubagent` is not available, use any other tool to run subagent or task. Use most capable model available.

Construct prompts for subagents as follows:

```
Read the file `<INSTRUCTION_FILE>` for detailed review instructions, then follow them to review the following change.

## <title>

### Description
<task description>

### Diff
<link to file containing the diff>
```

Where `<INSTRUCTION_FILE>` is the full path to the instruction file (e.g. `<SKILL_DIRECTORY>/criteria/architecture.md`).

### Step 5: Merge results

Compile all findings from all subagents into a single deduplicated list:

1. Collect all findings from each subagent response.
2. Group findings by file and line number.
3. Merge issues that describe the same problem (same file, similar line range, same category). When merging, note which type of review flagged it.
4. Keep the best description and suggested fix from among duplicates.
5. Sort by priority (P0 first), then by file path.
6. Filter put any false positives (if subagent itself said that it's not a real issue or you're 100% sure it's not a real issue).

```
## Comprehensive Review Findings

| # | Priority | Issue | File:Line | Review type |
|---|----------|-------|-----------|------------|
| 1 | P0 | Description | path:line | architecture, security |
| 2 | P1 | Description | path:line | correctness |
| ... | | | | |

### Details

#### 1. [P0] Issue title
**File:** `path/to/file:line`
**Review type** architecture, security

Description and why it matters.

**Suggested fix:**
\`\`\`
code
\`\`\`
```

### Step 6: Ask user how to handle each finding

Ask questions to let the user decide what to do with each finding:

- Use one question per finding, presenting each with its number, priority, and short description.
- **PR mode options**: "Fix", "Post comment", "Ignore"
- **Local mode options**: "Fix", "Ignore"
- Use tool to ask questions if available. Ask all questions with on tool call if tool allows asking multiple questions at once. Otherwise, ask sequentially.
- If no tool available, ask all questions at once with regular message to user.

### Step 7: Apply fixes for issues marked "Fix"

For each finding the user chose "Fix":

1. Read the relevant file and understand the surrounding context.
2. Apply the suggested fix (or an appropriate fix if the suggestion is incomplete).
3. After all fixes are applied, present a summary of changes made.

### Step 8: Post selected issues as PR comments (PR mode only)

**Skip this step entirely if no findings were marked "Post comment".**

Only applies in PR mode. Use the GitHub reviews API to post line-specific comments for selected issues:

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews \
  --method POST \
  -f event='COMMENT' \
  -f body='## Comprehensive Code Review

### Findings Summary

| Priority | Issue | Location | Review type |
|----------|-------|----------|------------|
| P0 | ... | file:line | review-type |

### Recommendation
[Concise recommendation]' \
  --input - << 'EOF'
{
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**[P0] Issue Title** (review type: code-quality)\n\nDescription.\n\n**Suggested fix:**\n```\ncode\n```"
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
- Include the category (Architecture, Security, Performance, Code Quality, Correctness) in each comment
