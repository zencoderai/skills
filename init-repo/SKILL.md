---
name: init-repo
description: "Initialize a repository with an AGENTS.md contributor guide by analyzing project structure, build commands, coding conventions, and git history. Uses parallel multi-provider analysis via ZencoderSubagent for comprehensive coverage. Use when the user asks to initialize a repo, create AGENTS.md, generate contributor guidelines, or set up agent-oriented documentation for a codebase."
metadata:
  version: 1.0.0
---

# Repository Initialization — AGENTS.md Generator

Analyze a codebase and generate a concise, accurate `AGENTS.md` contributor guide using parallel multi-provider drafting and best-of merge.

**Target:** $ARGUMENTS or the current working directory.

---

## Phase 1 — Probe the Codebase

Gather raw facts into a structured temp file. **Never invent information — only record what is actually found.**

Determine a short repo name from the directory or `git remote get-url origin`. Save all output to `/tmp/init-repo-probe-{repo-name}.md`.

### 1.1 File tree

```bash
find . -maxdepth 3 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' | head -200
```

Record the output under a `## File Tree` heading.

### 1.2 Build, test, and dev commands

Search for and extract command definitions from these sources (skip any that don't exist):

| Source | What to extract |
|--------|----------------|
| `package.json` | `scripts` object |
| `Makefile` | Target names and their comments |
| `pyproject.toml` | `[tool.poetry.scripts]`, `[project.scripts]`, or test/lint config |
| `Cargo.toml` | `[[bin]]` entries, workspace members |
| `go.mod` | Module path |
| `docker-compose.yml` | Service names |

Record under `## Build & Commands`.

### 1.3 Coding conventions

Check for and record the presence and key settings of:

- Linter configs: `.eslintrc.*`, `eslint.config.*`, `ruff.toml`, `.flake8`, `.rubocop.yml`
- Formatter configs: `.prettierrc*`, `biome.json`, `rustfmt.toml`
- Type checking: `tsconfig.json` (note `strict` setting), `mypy.ini`, `pyrightconfig.json`
- Agent rules: `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`
- Pre-commit hooks: `.husky/`, `.pre-commit-config.yaml`, `.githooks/`

If `.cursorrules` or `.github/copilot-instructions.md` exist, include their full content.

Record under `## Coding Conventions`.

### 1.4 Git history

```bash
git log --oneline -20 --no-decorate
```

Record under `## Recent Commits`. If this fails (not a git repo or shallow clone), note the limitation.

### 1.5 README and existing docs

If `README.md` exists, include its full content under `## README`.

If `AGENTS.md` already exists, include it under `## Existing AGENTS.md` and set a flag: `IMPROVEMENT_MODE=true`.

If `CLAUDE.md` exists, include it under `## Existing CLAUDE.md`.

### 1.6 Finalize probe file

Verify `/tmp/init-repo-probe-{repo-name}.md` is written and non-empty before proceeding.

---

## Phase 2 — Parallel Multi-Provider Drafting

Launch one `ZencoderSubagent` per available provider that supports `hard` complexity. Each receives the same prompt:

```
You are generating an AGENTS.md file for a code repository. Below are raw facts gathered from the codebase.

CRITICAL RULES:
- Only include information directly supported by the facts below
- Never invent commands, file paths, or conventions not found in the facts
- If a section has no supporting evidence, omit it entirely
- Keep the total document between 200-400 words
- Be specific to THIS repository — no generic advice

DOCUMENT FORMAT:
- Title: "# Repository Guidelines"
- Use ## headings for sections
- Keep explanations short, direct, and actionable
- Include actual commands, not descriptions of what commands might exist

SECTIONS (include only if evidence exists in the facts):

## Project Structure & Module Organization
Outline where source code, tests, and assets live. Focus on non-obvious structure.

## Build, Test, and Development Commands
List actual commands from the build system. Briefly explain what each does.

## Coding Style & Naming Conventions
Specify enforced rules from linter/formatter configs. Include tool names.

## Testing Guidelines
Identify test framework, how to run tests (including a single test), coverage requirements.

## Commit & Pull Request Guidelines
Derive commit message conventions from the git history. Note any PR templates.

Add other sections only if the facts strongly support them (e.g., Architecture Overview, Security, Agent Instructions).

{IF IMPROVEMENT_MODE}
An existing AGENTS.md is included in the facts. Improve it: fix inaccuracies, fill gaps, remove generic advice, and ensure all commands are current. Preserve any correct, specific content.
{END IF}

--- CODEBASE FACTS ---
<contents of /tmp/init-repo-probe-{repo-name}.md>
```

Save each provider's response to `/tmp/init-repo-draft-{provider}.md`.

---

## Phase 3 — Best-of Merge

Compare all provider drafts section by section:

1. **For each section** present in any draft:
   - Pick the version that is most specific and accurate (contains real commands, real paths)
   - Between equally specific versions, prefer the more concise one
   - If only one provider included the section, use it if it's supported by probe facts
   - If a section contains invented information (not in probe facts), discard it

2. **Assemble** the merged sections into a single document with:
   - Title: `# Repository Guidelines`
   - Consistent heading levels and formatting
   - No repeated information across sections

3. **Validate** the merged result:
   - Total length: 200-400 words
   - Every command mentioned exists in the probe facts
   - Every file path mentioned exists in the file tree
   - No generic advice ("always write tests", "use meaningful names", etc.)
   - No invented sections

4. **Trim** if over 400 words — cut the least specific content first.

---

## Phase 4 — Confirm and Write

### If IMPROVEMENT_MODE (existing AGENTS.md found):

Present the diff between the existing and new version. Ask the user to confirm before overwriting:

```
I've generated an improved AGENTS.md. Here are the changes:
<diff>
Should I apply these changes?
```

### If new file:

Present the complete AGENTS.md content and ask for confirmation before writing.

### Write

Save the final `AGENTS.md` to the repository root.

Clean up temp files:
```bash
rm -f /tmp/init-repo-probe-*.md /tmp/init-repo-draft-*.md
```

---

## Guidelines

- **Never fabricate** — if a section has no evidence, omit it
- **Prefer commands over prose** — `npm test` over "run the test suite"
- **Incorporate agent rules** — if .cursorrules or copilot instructions exist, weave their important parts into the relevant sections
- **Respect existing work** — in improvement mode, preserve correct specific content
- **Stay under 400 words** — conciseness is the primary quality signal
