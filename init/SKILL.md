---
name: init
description: "Initialize a repository with an AGENTS.md contributor guide by analyzing project structure, build commands, coding conventions, and git history. Use when the user asks to initialize a repo, create AGENTS.md, generate contributor guidelines, or set up agent-oriented documentation for a codebase."
metadata:
  version: 1.1.0
---

# Repository Initialization — AGENTS.md Generator

Analyze a codebase and generate a concise, accurate `AGENTS.md` contributor guide.

**Target:** $ARGUMENTS or the current working directory.

---

## Phase 1 — Probe the Codebase

Gather raw facts about the repository. **Only record what is actually found — never invent information.**

### 1.1 File tree

Map the repo structure (3 levels deep, excluding .git, node_modules, dist, build, __pycache__, .venv). This is analysis input — the output AGENTS.md should describe non-obvious architecture, not list directories. Focus on the "big picture" architecture that requires reading multiple files to understand.

### 1.2 Build, test, and dev commands

Extract actual command definitions from these sources (skip any that don't exist):

| Source | What to extract |
|--------|----------------|
| `package.json` | `scripts` object |
| `Makefile` | Target names and their comments |
| `pyproject.toml` | `[tool.poetry.scripts]`, `[project.scripts]`, or test/lint config |
| `Cargo.toml` | `[[bin]]` entries, workspace members |
| `go.mod` | Module path |
| `docker-compose.yml` | Service names |

### 1.3 Coding conventions

Check for and record the presence and key settings of:

- Linter configs: `.eslintrc.*`, `eslint.config.*`, `ruff.toml`, `.flake8`, `.rubocop.yml`
- Formatter configs: `.prettierrc*`, `biome.json`, `rustfmt.toml`
- Type checking: `tsconfig.json` (note `strict` setting), `mypy.ini`, `pyrightconfig.json`
- Agent rules: `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`
- Pre-commit hooks: `.husky/`, `.pre-commit-config.yaml`, `.githooks/`

If agent rules files exist, read them and extract the important parts (not verbatim — focus on conventions and rules that matter for code generation).

### 1.4 Git history

Review the last 20 commits to identify commit message conventions and patterns.

If this fails (not a git repo or shallow clone), note the limitation and skip.

### 1.5 README and existing docs

- If `README.md` exists, read it for context about the repo's purpose and setup.
- If `AGENTS.md` already exists, read it — you'll be improving it rather than starting fresh.
- If `CLAUDE.md` exists, read it for additional context.

---

## Phase 2 — Generate AGENTS.md

Using the gathered facts, write the AGENTS.md document.

### Document requirements

- Title: `# Repository Guidelines`
- 200-400 words (exceed only if the repository's complexity genuinely demands it)
- Direct, instructional tone
- Do not repeat yourself across sections

### Sections to include (omit any that don't apply)

**## Project Structure & Module Organization**
Focus on architecture that requires reading multiple files to understand. Omit anything a developer would learn by opening a single file.

**## Build, Test, and Development Commands**
List actual commands from the build system. Include how to run a single test. Briefly explain what each does.

**## Coding Style & Naming Conventions**
Specify enforced rules from linter/formatter configs. Include tool names.

**## Testing Guidelines**
Identify test framework, how to run tests, coverage requirements if any.

**## Commit & Pull Request Guidelines**
Derive commit message conventions from the actual git history. Note any PR templates.

Add other sections only if the facts strongly support them (e.g., Architecture Overview, Security, Agent Instructions).

### What to NEVER include

Do not include obvious instructions or generic development practices such as:
- "Provide helpful error messages to users"
- "Write unit tests for all new utilities"
- "Never include sensitive information (API keys, tokens) in code or commits"
- "Use meaningful variable names"

Do not invent sections like "Common Development Tasks", "Tips for Development", "Support and Documentation" unless the repo's own documentation expressly contains them.

Do not list every component or file in the repository — only document what is non-obvious.

### If improving an existing AGENTS.md

Fix inaccuracies, fill gaps, remove generic advice, and ensure all commands are current. Preserve any correct, specific content. Present the diff to the user and ask to confirm before overwriting.

### If creating a new AGENTS.md

Write the file directly to the repository root. No confirmation needed.

---

## Phase 3 — Validate

Before finalizing, verify:

- Every command mentioned actually exists in the build system
- Every file path mentioned exists in the repo
- No generic advice slipped in
- No repeated information across sections
- The document stays within the target word count
- Cursor/Copilot rules are incorporated (important parts woven into relevant sections, not dumped verbatim)

---

## Guidelines

- **Never fabricate** — if a section has no evidence, omit it entirely
- **Prefer commands over prose** — `npm test` over "run the test suite"
- **Big picture only** — document architecture that spans multiple files, skip the obvious
- **Incorporate agent rules** — weave important parts of .cursorrules or copilot instructions into relevant sections
- **Respect existing work** — in improvement mode, preserve correct specific content
- **Conciseness is quality** — every sentence must earn its place
