---
name: comprehensive-review
description: "Comprehensive code review using parallel specialized subagents. Use when you want a thorough code review covering architecture, security, performance, code quality, requirements compliance, and bugs. Works with GitHub PR links OR local branch changes. If a PR URL is provided, fetches PR details and can post comments. If no PR is provided, reviews the diff between the current branch and its base branch plus any uncommitted changes. IMPORTANT: this skill is costly, don't use it unless user explicitly requested to use this skill."
disable-model-invocation: true
metadata:
  version: 1.0.0
---

# Comprehensive Code Review

Run parallel specialized code reviews via subagents, covering architecture, security, performance, code quality, requirements compliance, and bugs. Merge findings and let the user act on them. Works with both GitHub PRs and local branch diffs.

## Workflow

### Step 1: Determine review mode

Check if the user provided a GitHub PR link.

- **PR mode**: A PR URL is provided matching `https://github.com/<OWNER>/<REPO>/pull/<PR_NUMBER>`. Extract owner, repo, and PR number.
- **Local mode**: No PR URL provided. The review will be based on the diff between the current branch and its base branch, plus any uncommitted changes.

### Step 2: Fetch diff and task description via subagent

Call a subagent to gather all change details, save the diff, and checkout the correct branch.

**CRITICAL**: You MUST spawn a subagent for this step. Do NOT perform the diff-gathering, branch detection, or complexity assessment yourself. Do NOT read the file `<SKILL_DIRECTORY>/fetch-diff.md` yourself. The subagent must read it and follow its instructions.

Construct the subagent prompt as follows:

```
Read the file `<SKILL_DIRECTORY>/fetch-diff.md` for detailed instructions, then follow them.

Mode: <PR mode or Local mode>
<If PR mode: Owner: <OWNER>, Repo: <REPO>, PR Number: <PR_NUMBER>>

IMPORTANT: Do NOT invoke the Skill tool. Do NOT use the TodoWrite tool. All instructions you need are in the file specified above.
```

Use a subagent tool to spawn the subagent. Use a cheap/fast model since this is a data-gathering task that doesn't require deep reasoning.

The subagent will return:
- **Diff file path**: absolute path to the saved diff file (must start with `/`, e.g. `/tmp/review-diff-feature.patch`)
- **Diff line count**: total number of lines in the diff file
- **Title**: the PR title or summary from commits
- **Description**: comprehensive task description with all requirements
- **Complexity**: one of `simple`, `medium`, or `hard`

Remember these values for use in subsequent steps.

### Step 3: Run specialized reviews

The review strategy depends on the **complexity** returned by the fetch-diff subagent.

#### Review Criteria and Instruction Files

Each review criterion has a corresponding instruction file inside this skill's directory:

| Review criterion | Instruction File |
|-------------|-----------------|
| architecture | `criteria/architecture.md` |
| security | `criteria/security.md` |
| performance | `criteria/performance.md` |
| code-quality | `criteria/code-quality.md` |
| requirements-compliance | `criteria/requirements-compliance.md` |
| bugs | `criteria/bugs.md` |

#### Strategy A: Simple complexity

For **simple** PRs, perform the review yourself (the root agent) without calling subagents.

1. Read **all 6** criteria instruction files from `<SKILL_DIRECTORY>/criteria/`.
2. Read the diff file.
3. Apply all criteria to review the change yourself, producing findings in the same format as subagents would.

#### Strategy B: Medium complexity

For **medium** PRs, launch **6 parallel subagent calls** — one per review criterion.

**CRITICAL**: You MUST spawn subagents for this step. Do NOT read the criteria instruction files yourself. Do NOT perform the reviews yourself. Each subagent must read its own instruction file.

Use a subagent tool to spawn each subagent. Select the single most powerful model from each available provider. Alternate these models across the 6 criteria (e.g., provider A's best model for criteria 1, 3, 5 and provider B's best model for criteria 2, 4, 6). If only 1 provider is available, use its most powerful model for all 6.

Construct prompts for subagents as follows:

```
Read the file `<INSTRUCTION_FILE>` for detailed review instructions, then follow them to review the following change.

## <title>

### Task Description
<task description>

### Diff
Read the diff from file: <absolute path to diff file> (total lines: <diff line count>)

IMPORTANT: Do NOT invoke the Skill tool. Do NOT use the TodoWrite tool. Do NOT run tests, builds, linters, or type-checks — your review is based on static analysis only. All review instructions are in the file specified above.
```

Where `<INSTRUCTION_FILE>` is the absolute path to the instruction file (e.g. `<SKILL_DIRECTORY>/criteria/architecture.md`).

#### Strategy C: Hard complexity

For **hard** PRs, launch **2 parallel subagent calls per criterion** (12 total) — one per criterion per model, using 2 different models from different providers for diverse perspectives.

**CRITICAL**: You MUST spawn subagents for this step. Do NOT read the criteria instruction files yourself. Do NOT perform the reviews yourself. Each subagent must read its own instruction file.

**Model selection**: Choose exactly 2 models — the single most powerful model from each of 2 different providers. If only 1 provider is available, use its most powerful model for all 12 calls (fall back to Strategy B behavior with 2 calls per criterion).

Use a subagent tool to spawn each subagent.

For each of the 6 criteria, launch 2 subagents — one with each model.
Use following prompt:

```
Read the file `<INSTRUCTION_FILE>` for detailed review instructions, then follow them to review the following change.

## <title>

### Task Description
<task description>

### Diff
Read the diff from file: <absolute path to diff file> (total lines: <diff line count>)

IMPORTANT: Do NOT invoke the Skill tool. Do NOT use the TodoWrite tool. Do NOT run tests, builds, linters, or type-checks — your review is based on static analysis only. All review instructions are in the file specified above.
```

Where `<INSTRUCTION_FILE>` is the absolute path to the instruction file (e.g. `<SKILL_DIRECTORY>/criteria/architecture.md`).

All 12 calls should be launched in parallel.

### Step 4: Merge results

Compile all findings into a single deduplicated list. For **simple** PRs, you already have all findings from your self-review. For **medium** and **hard** PRs, collect findings from all subagent responses.

1. Collect all findings from each review (self-review or subagent responses).
2. Group findings by file and line number.
3. Merge issues that describe the same problem (same file, similar line range, same category). When merging, combine their review types. For **hard** PRs, findings from different models on the same criterion that agree strengthen confidence; findings from only one model should be noted as lower confidence.
4. Keep the best description and suggested fix from among duplicates.
5. Sort by priority (P0 first), then by file path.
6. Filter out any false positives (if a subagent itself said that it's not a real issue or you're 100% sure it's not a real issue).

```
## Comprehensive Review Findings

| # | Priority | Issue | File:Line | Review type |
|---|----------|-------|-----------|------------|
| 1 | P0 | Description | link to specific line in file | architecture(opus-4-6-think), security(gpt-5-3-codex) |
| 2 | P1 | Description | link to specific line in file | bugs(opus-4-6-think) |
| ... | | | | |

### Details

#### 1. [P0] Issue title
**File:** link to specific line in file
**Review type:** architecture(opus-4-6-think), security(gpt-5-3-codex)

Description and why it matters.

**Suggested fix:**
\`\`\`
code
\`\`\`
```

### Step 5: Ask user how to handle each finding

**Skip this step if the user already specified what to do with findings in their initial prompt** (e.g., "fix all issues", "post comments for all P0s", etc.). In that case, proceed directly to Steps 6/7 based on their instructions.

Otherwise, send a single message asking the user which findings to fix or post as comments. List each finding with its number, priority, and short description, and ask the user to reply with their choices.

- **PR mode**: Ask which issues to fix and which to post as PR comments.
- **Local mode**: Only ask which issues to fix. Do NOT mention posting comments.

### Step 6: Apply fixes for issues marked "Fix"

For each finding the user chose "Fix":

1. Read the relevant file and understand the surrounding context.
2. Apply the suggested fix (or an appropriate fix if the suggestion is incomplete).
3. After all fixes are applied, present a summary of changes made.

### Step 7: Post selected issues as PR comments (PR mode only)

**Skip this step entirely if no findings were marked "Post comment".**

Only applies in PR mode. Call a subagent to post line-specific comments via the GitHub Reviews API.

**CRITICAL**: You MUST spawn a subagent for this step. Do NOT perform the comment posting yourself. Do NOT read the file `<SKILL_DIRECTORY>/post-comments.md` yourself. The subagent must read it and follow its instructions.

Construct the subagent prompt as follows:

```
Read the file `<SKILL_DIRECTORY>/post-comments.md` for detailed instructions, then follow them.

Owner: <OWNER>
Repo: <REPO>
PR Number: <PR_NUMBER>
Diff file path: <absolute path to diff file>

Findings to post:

<For each finding marked "Post comment", include:>
### Finding <#>
- **Priority**: <priority>
- **Title**: <issue title>
- **File**: <file path>
- **Line**: <line number>
- **Review type**: <review type with model names>
- **Description**: <description>
- **Suggested fix**: <suggested fix or "None">

IMPORTANT: Do NOT invoke the Skill tool. Do NOT use the TodoWrite tool. All instructions you need are in the file specified above.
```

If user added custom notes to a finding, update description and/or suggested fix according to these notes.

Use a subagent tool to spawn the subagent. Use a cheap/fast model since this is a data-posting task that doesn't require deep reasoning.
