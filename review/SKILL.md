---
name: review
description: "Delegate code review to a subagent with a specified model. Use when the user asks to review code changes, diffs, or commits AND specifies a model to use (e.g., 'review with opus', 'use sonnet to review', 'review changes with gemini'). The user provides the model name and review instructions."
metadata:
  version: 1.0.0
---

# Delegated Code Review

Gather context about code changes and delegate the actual review to a subagent running the `code-review` skill with a user-specified model.

## Expected Prompt Format

```
Use review skill with <model-id> model to review the changes. Review instructions: <instructions>
```

The user may also provide commit hashes, a git range, or a branch name alongside this.

## Workflow

### Step 1: Parse the user request

Extract from the user's prompt:
- **Model**: The model ID to use for the subagent.
- **Review instructions**: Any text after "Review instructions:" — pass these verbatim to the subagent.
- **Change scope**: Commit hashes, git range, branch name, or indication to review staged/unstaged changes. If not provided, default to reviewing the latest commit (`HEAD~1..HEAD`).

### Step 2: Gather the diff and related context

Collect all information the review subagent will need:

1. **Get the diff** using git:
   ```bash
   # Default (latest commit):
   git diff HEAD~1..HEAD
   # Unstaged changes:
   git diff
   # Staged changes:
   git diff --cached
   # Single commit:
   git diff "<commit>^..<commit>"
   # Range:
   git diff "<commit1>..<commit2>"
   # Branch comparison:
   git diff main..<branch>
   ```

2. **Identify changed files** from the diff output.

3. **Read full contents of changed files** to provide surrounding context. Use the Read tool on each changed file.

4. **Check for related context**:
   - Read any test files related to the changed files
   - Check for configuration changes that may affect behavior
   - Note any related type definitions or interfaces

### Step 3: Spawn the review subagent

Use `spawn_subagent` with:
- **agent**: `"generic"`
- **model**: The model extracted from the user's request
- **prompt**: A comprehensive prompt that includes:
  1. An instruction to invoke the `code-review` skill
  2. The user's review instructions (verbatim)
  3. The full diff
  4. Full contents of all changed files (for context)
  5. Any related context gathered (tests, types, configs)

Prompt template:

```
[Skill: code-review]

Review the following code changes.

## Review Instructions

{user's review instructions, verbatim}

## Diff

<diff>
{paste the full diff here}
</diff>

## Changed File Contents

{for each changed file, include:}
### {file_path}
\`\`\`
{full file contents}
\`\`\`

## Additional Context

{any related files, test files, type definitions, or user-provided requirements}
```

### Step 4: Relay the result

Return the subagent's review output directly to the user without modification.
