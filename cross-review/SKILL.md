---
name: cross-review
description: "Cross review code using a subagent with a specified model. Use when the user asks to review code changes AND specifies a model to use (e.g., 'review with opus', 'use sonnet to review', 'review changes with gemini'). The key differentiator from the regular code-review skill is that the user explicitly specifies which model should perform the review. The root agent reconstructs what changed from its own conversation history — no git commands are used."
metadata:
  version: 1.0.0
---

# Cross Review

Reconstruct what you changed during this conversation, then delegate the actual review to a single subagent running the `code-review` skill with a user-specified model.

IMPORTANT: Steps 1–2 run in the current agent (the master). Only Step 3 spawns a subagent. Do NOT spawn a subagent to execute this skill's workflow — that creates unnecessary nesting.

## Expected Prompt Format

```
Use review skill with <model-id> model to review the changes. Review instructions: <instructions>
```

## Workflow

### Step 1: Parse the user request

Extract from the user's prompt:
- **Model**: The model ID to use for the subagent. Validate against the available models.
  - If the user-specified model is invalid, automatically choose one of the most powerful available models from a different provider.
- **Review instructions**: Any text after "Review instructions:" — pass these verbatim to the subagent.
- **Change scope**: Any indication of what should be reviewed. If not provided, default to reviewing all changes made by you during this conversation.

### Step 2: Gather context from your own changes

Collect all information the review subagent will need. Do this in the current agent — do NOT delegate this step. Do NOT use git diff or any git commands to obtain changes.

You already know what you changed — reconstruct the diff from your own conversation history:

1. **Reconstruct the changes** by reviewing every Edit, Write, and Bash tool call you made during this conversation. For each changed file, build a before/after picture:
   - **Edit calls**: The `old_string` → `new_string` pairs are your diff hunks.
   - **Write calls**: The entire file content is new (or a full rewrite).
   - **Bash calls**: If you ran commands that modified files (e.g., `sed`, `mv`, `rm`), note those changes.

   Compose a unified diff-style summary of all changes. Group changes by file.

   **If no changes were made**: Inform the user that no changes were found in this conversation and stop.

2. **Read the final state of changed files** to provide full surrounding context. Use the Read tool on each changed file.

3. **Check for related context**:
   - Read test files related to the changed files, prioritizing nearby paths and excluding dependency/vendor directories (e.g., `node_modules`, `.git`, `dist`, `build`, `coverage`)
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
- All necessary context is provided below. Read files only if provided context is clearly incomplete.
- Review the changes independently and objectively. Do not assume the changes are correct.

## Review Instructions

{user's review instructions, verbatim}

## Changes

{reconstructed diff or before/after summary of all changes, grouped by file}

## Full File Contents

{DO NOT include full file contents as subagent can read them if needed}

## Additional Context

{links to any related files, test files, type definitions, or user-provided requirements}
```

### Step 4: Relay the result

Present the subagent's review to the user. You may add a brief attribution (e.g., which model produced the review) but do not alter the review findings or recommendations.

## Error Handling

- **`spawn_subagent` fails or times out**: Inform the user of the failure. Suggest retrying or using a different model.
- **No changes in conversation**: Inform the user no changes were found and stop.
- **Subagent returns an error or incomplete review**: Relay whatever was returned and note that the review may be incomplete.
