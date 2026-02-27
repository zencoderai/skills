# init-repo Skill Design

## Purpose

Generate an `AGENTS.md` contributor guide for a repository by analyzing the codebase with multiple AI providers in parallel, then merging the best sections from each draft.

## Architecture: Probe-Then-Draft

```
Phase 1 (Probe)        → Main agent gathers codebase facts → /tmp/init-repo-probe-*.md
Phase 2 (Draft)         → ZencoderSubagent per provider (parallel) → /tmp/init-repo-draft-*.md
Phase 3 (Merge)         → Best-of-section merge + validation → AGENTS.md
Phase 4 (Confirm/Write) → Present to user, write to repo root
```

## Phase 1: Codebase Probe

Main agent gathers raw facts into a structured temp file:

1. **File tree** — 3 levels deep, excluding node_modules/dist/build/.git
2. **Build/test commands** — package.json scripts, Makefile targets, pyproject.toml, Cargo.toml, go.mod
3. **Coding conventions** — Linter configs, tsconfig, .cursorrules, .github/copilot-instructions.md
4. **Git history** — Last 20 commit messages for style patterns
5. **README.md** — Full content if present
6. **Existing AGENTS.md/CLAUDE.md** — For improvement mode

Output saved to `/tmp/init-repo-probe-{repo-name}.md`.

## Phase 2: Parallel Multi-Provider Drafting

One ZencoderSubagent per hard-complexity provider. Each receives the probe facts + AGENTS.md template with instructions to:

- Generate 200-400 word AGENTS.md titled "Repository Guidelines"
- Only include information supported by probe facts
- Omit sections that don't apply
- If existing AGENTS.md found, improve rather than restart

Sections: Project Structure, Build/Test/Dev Commands, Coding Style, Testing Guidelines, Commit/PR Guidelines, optional extras.

## Phase 3: Best-of Merge

1. Compare drafts section-by-section
2. Pick most specific, accurate, concise version per section
3. Prefer actual commands over vague descriptions
4. Deduplicate across sections
5. Validate: 200-400 words, traceable to probe facts, no invented info

## Phase 4: Confirm & Write

- If existing AGENTS.md: show diff, ask user to confirm
- Write final AGENTS.md to repo root

## Edge Cases

- Existing AGENTS.md → improvement mode
- Cursor/Copilot rules → incorporated into probe
- Monorepo → multiple build systems noted
- No build system → section omitted
- Shallow clone → git history degraded gracefully

## Decisions

- **Output**: AGENTS.md only (not CLAUDE.md)
- **Subagent strategy**: ZencoderSubagent multi-provider
- **Merge strategy**: Best-of-section merge
- **Skill format**: Single SKILL.md, no additional files
