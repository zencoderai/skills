#!/bin/bash
# Install/uninstall a skill across all supported CLIs via symlinks
# Usage:
#   install-skill.sh <skill-name>              # Install
#   install-skill.sh <skill-name> --uninstall   # Uninstall
#   install-skill.sh --list                     # List installed skills
set -euo pipefail

SKILLS_HOME="${SKILLS_HOME:-$HOME/skills}"

# All supported CLI skill directories
CLI_DIRS=(
    "$HOME/.claude/skills"
    "$HOME/.zencoder/skills"
    "$HOME/.codex/skills"
    "$HOME/.gemini/skills"
)

# macOS-specific app directories
if [[ "$(uname)" == "Darwin" ]]; then
    CLI_DIRS+=(
        "$HOME/Library/Application Support/Claude/skills"
        "$HOME/Library/Application Support/Codex/skills"
    )
fi

list_skills() {
    echo "Installed skills (in $SKILLS_HOME):"
    for dir in "$SKILLS_HOME"/*/; do
        [[ -d "$dir" ]] || continue
        skill=$(basename "$dir")
        echo "  $skill"
        for cli_dir in "${CLI_DIRS[@]}"; do
            if [[ -L "$cli_dir/$skill" ]]; then
                echo "    -> $(basename "$(dirname "$cli_dir")")/skills/"
            fi
        done
    done
}

if [[ "${1:-}" == "--list" ]]; then
    list_skills
    exit 0
fi

if [[ -z "${1:-}" ]]; then
    echo "Usage: install-skill.sh <skill-name> [--uninstall]" >&2
    echo "       install-skill.sh --list" >&2
    exit 1
fi

SKILL_NAME="$1"
SKILL_PATH="$SKILLS_HOME/$SKILL_NAME"
UNINSTALL="${2:-}"

if [[ "$UNINSTALL" == "--uninstall" ]]; then
    echo "Uninstalling $SKILL_NAME from all CLIs..."
    for cli_dir in "${CLI_DIRS[@]}"; do
        if [[ -L "$cli_dir/$SKILL_NAME" ]]; then
            rm "$cli_dir/$SKILL_NAME"
            echo "  Removed: $cli_dir/$SKILL_NAME"
        fi
    done
    echo "Done."
    exit 0
fi

if [[ ! -d "$SKILL_PATH" ]]; then
    echo "Error: Skill directory not found: $SKILL_PATH" >&2
    exit 1
fi

if [[ ! -f "$SKILL_PATH/SKILL.md" ]]; then
    echo "Error: No SKILL.md found in $SKILL_PATH" >&2
    exit 1
fi

echo "Installing $SKILL_NAME to all CLIs..."
for cli_dir in "${CLI_DIRS[@]}"; do
    mkdir -p "$cli_dir"
    ln -sf "$SKILL_PATH" "$cli_dir/$SKILL_NAME"
    echo "  Linked: $cli_dir/$SKILL_NAME -> $SKILL_PATH"
done
echo "Done. Skill '$SKILL_NAME' is now available in all CLIs."
