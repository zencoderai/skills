# Zencoder Skills

Open-source skills for AI coding agents. Works with Claude Code, Zen CLI, Codex CLI, Gemini CLI, and other AI coding tools that support the skill format.

## Available Skills

### OSS Security Suite

A set of skills that automatically gate external code with security assessments before it enters your environment.

| Skill | What it does | Triggers on |
|-------|-------------|-------------|
| [oss-security-check](./oss-security-check/) | Core security assessment engine (web search + code scan) | Called by other skills, or directly: "check this repo", "audit this project" |
| [git](./git/) | Gates `git clone` of public repos | "clone this repo", "git clone", "check out this project" |
| [install-mcp](./install-mcp/) | Gates MCP server installations from external sources | "install this MCP server", "add this MCP tool" |
| [install-skill](./install-skill/) | Gates skill imports from external sources | "install this skill", "import this skill from GitHub" |

**How they work together:**

```
oss-security-check          ← shared assessment engine (web search + code scan)
├── git                     ← gates git clone (public/private probe)
├── install-mcp             ← gates MCP installs (+ tool inventory, transport check)
└── install-skill           ← gates skill imports (+ deep prompt injection analysis)
```

The `git`, `install-mcp`, and `install-skill` skills each handle their specific trigger and probe, then delegate to `oss-security-check` for the actual assessment. This keeps scanning logic in one place — customize it once, all three skills benefit.

## Installation

Copy the skill directories to your AI coding tool's skill location:

| CLI | Skill Directory |
|-----|-----------------|
| Claude Code | `~/.claude/skills/` |
| Zen CLI | `~/.zencoder/skills/` |
| Codex CLI | `~/.codex/skills/` |
| Gemini CLI | `~/.gemini/skills/` |

Example (install all four skills for Claude Code):

```bash
git clone https://github.com/zencoderai/skills.git
cp -R skills/oss-security-check ~/.claude/skills/
cp -R skills/git ~/.claude/skills/
cp -R skills/install-mcp ~/.claude/skills/
cp -R skills/install-skill ~/.claude/skills/
```

## Customization

The default skills use a generic public/private probe. Customize the trust boundary for your org:

> *"Modify the git skill so that repos in the `<your-org>` GitHub organization skip the security gate, and all other public repos are scanned before cloning."*

## Contributing

PRs welcome. Each skill is a single `SKILL.md` file — keep them focused and under 2,000 words.

## License

MIT
