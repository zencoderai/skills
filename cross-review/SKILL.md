---
name: cross-review
description: "Cross review code using a subagent with a specified model. Use when the user asks to review code changes, diffs, or commits AND specifies a model to use (e.g., 'review with opus', 'use sonnet to review', 'review changes with gemini'). The key differentiator from the regular code-review skill is that the user explicitly specifies which model should perform the review."
metadata:
  version: 1.0.0
---

# Cross Review

Gather context about code changes in the current agent, then delegate the actual review to a single subagent running the `code-review` skill with a user-specified model.

IMPORTANT: Steps 1–2 run in the current agent (the master). Only Step 3 spawns a subagent. Do NOT spawn a subagent to execute this skill's workflow — that creates unnecessary nesting.

## Expected Prompt Format

```
Use review skill with <model-id> model to review the changes. Review instructions: <instructions>
```

The user may also provide commit hashes, a git range, or a branch name alongside this.

## Workflow

### Step 1: Parse the user request

Extract from the user's prompt:
- **Model**: The model ID to use for the subagent. Validate against the available models.
  - If the user-specified model is invalid, automatically choose one of the most powerful available models from a different provider.
- **Review instructions**: Any text after "Review instructions:" — pass these verbatim to the subagent.
- **Change scope**: Any indication of what should be reviewed. If not provided, default to reviewing all changes made by you before that.

### Step 2: Gather the diff and related context

Collect all information the review subagent will need. Do this in the current agent — do NOT delegate this step.

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

   **Fallback if git is unavailable or diff commands fail**: If git commands fail (e.g., not a git repository, no commits yet), check the current conversation history for recent diffs or file edits made by tool calls. Reconstruct the diff from Edit tool results if available. If no diff can be obtained at all, inform the user and stop.

   **If the diff is empty**: Inform the user that no changes were found for the specified scope and stop.

2. **Identify changed files** from the diff output.

3. **Read full contents of changed files** to provide surrounding context. Use the Read tool on each changed file.

4. **Check for related context**:
   - Read test files related to the changed files, prioritizing nearby paths and excluding dependency/vendor directories (for example: `node_modules`, `.git`, `dist`, `build`, `coverage`)
   - Check for configuration changes that may affect behavior
   - Note any related type definitions or interfaces

### Step 3: Spawn the review subagent

Use `spawn_subagent` with:
- **skill**: `"code-review"`
- **model**: The model extracted from the user's request (validated in Step 1)
- **prompt**: use following template

```
Review the changes below using "code-review" skill.

IMPORTANT CONSTRAINTS:
- Do NOT edit, write, or execute any commands that modify files. This is a read-only review.
- All necessary context is provided below. Do not re-read changed files unless a provided file is clearly incomplete or truncated.
- Review the changes independently and objectively. Do not assume the changes are correct.

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

{links to any related files, test files, type definitions, or user-provided requirements}
```

### Step 4: Relay the result

Present the subagent's review to the user. You may add a brief attribution (e.g., which model produced the review) but do not alter the review findings or recommendations.

## Error Handling

- **`spawn_subagent` fails or times out**: Inform the user of the failure. Suggest retrying or using a different model.
- **Empty diff**: Inform the user no changes were found and stop.
- **Git unavailable**: Fall back to conversation history as described in Step 2.
- **Subagent returns an error or incomplete review**: Relay whatever was returned and note that the review may be incomplete.
