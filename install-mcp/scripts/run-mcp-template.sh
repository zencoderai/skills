#!/bin/bash
# MCP Server Wrapper Script Template
# Copy to ~/.config/[mcp-name]/run-mcp.sh and customize
# chmod 700 after copying
set -euo pipefail

# --- Customize these ---
MCP_NAME="mcp-name"
CREDENTIALS_FILE="$HOME/.config/$MCP_NAME/credentials.env"
MCP_COMMAND="/path/to/mcp-server"
MCP_ARGS=""
# -----------------------

if [[ ! -f "$CREDENTIALS_FILE" ]]; then
    echo "Error: Credentials file not found: $CREDENTIALS_FILE" >&2
    echo "Create it with: chmod 600 $CREDENTIALS_FILE" >&2
    exit 1
fi

PERMS=$(stat -f "%Lp" "$CREDENTIALS_FILE" 2>/dev/null || stat -c "%a" "$CREDENTIALS_FILE" 2>/dev/null)
if [[ "$PERMS" != "600" ]]; then
    echo "Warning: $CREDENTIALS_FILE permissions are $PERMS, expected 600" >&2
fi

source "$CREDENTIALS_FILE"
exec $MCP_COMMAND $MCP_ARGS "$@"
