---
name: install-mcp
description: This skill should be used when the user asks to "install an MCP server", "add this MCP server", "set up MCP", "configure this MCP tool", "add this to my MCP config", or mentions installing, setting up, or configuring any MCP (Model Context Protocol) server from an external source. Gates external MCP server installs with a security assessment.
version: 1.0.0
---

# Install MCP (Secure)

Gate every MCP server installation from an external/public source with a security assessment. Internal or previously-vetted servers install immediately.

## Trigger

Any user request that involves installing, configuring, or adding an MCP server.

## Workflow

### 1. Identify the source

MCP servers come from various sources. Determine the type:

| Source | Example | Action |
|--------|---------|--------|
| GitHub repo | `github.com/org/mcp-server` | Run the security gate |
| npm package | `npx @org/mcp-server` | Run the security gate |
| PyPI package | `pip install mcp-server` | Run the security gate |
| Local path | `~/projects/my-mcp-server` | Skip the gate — it's local code |
| Previously approved | Already in the team's vetted list | Skip the gate |

For GitHub repos, extract `<owner>/<repo>`. For npm/PyPI packages, extract the package name and look up its source repository.

### 2. Security gate (external sources only)

Read and execute the full assessment defined in the `oss-security-check` skill (`../oss-security-check/SKILL.md`).

Pass it:
- `<url>` — the source repository or package registry URL
- `<owner>/<repo>` — extracted from the source
- `<host>` — github.com, npmjs.com, pypi.org, etc.
- Context: "This is an MCP server. Run a thorough security assessment across all categories."

Wait for the assessment to complete.

### 3. MCP-specific checks (in addition to the base assessment)

After the base `oss-security-check` completes, perform these additional checks specific to MCP servers:

#### Tool inventory

List every tool the MCP server exposes. For each tool, note:
- What it does (read vs. write vs. execute)
- What permissions it needs
- Whether it accesses external systems

Present this as a table:

```
| Tool Name | Action Type | Permissions | External Access |
|-----------|-------------|-------------|-----------------|
```

#### Permission scope

Check the MCP server's configuration for:
- What environment variables / secrets it requires
- Whether it requests broad filesystem access
- Whether it opens network listeners
- Whether it requires Docker / privileged execution

#### Transport security

- Does it use stdio (local) or SSE/HTTP (network)?
- If network: is TLS required? Is auth required?
- Are there any exposed ports?

#### Supply chain verification

For MCP servers installed via package registries (npm, PyPI), verify the dependency chain. Small/indie packages are high-value targets — a single phished npm token can compromise every downstream user.

**Lock file and pinning:**
- Check that a lock file exists (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `requirements.txt` with hashes)
- Verify versions are pinned — not `*`, `latest`, `>=`, or unpinned ranges
- Run `npm audit` / `pip audit` and flag high-severity CVEs

**Package provenance (especially for small/single-maintainer projects):**
- Verify the npm/PyPI package owner matches the GitHub repo owner — a mismatch is a red flag for package name squatting
- Check the package publish history — a sudden publish after months of dormancy suggests account takeover, not a feature release
- Look for version anomalies — unexpected major bumps, yanked versions, or versions published outside normal patterns
- Check whether the package requires post-install scripts (`preinstall`, `install`, `postinstall` in `package.json`, custom build commands in `setup.py` / `pyproject.toml`) — these execute automatically during install, before any code review

**If the MCP server is installed via `npx <package>`:**
- Run `npm pack --dry-run <package>` first to inspect what will be downloaded
- Check the package tarball contents for unexpected files

### 4. Present combined results

Show the base `oss-security-check` assessment table plus the MCP-specific findings:

```
## MCP Server Assessment: <name>

[Base assessment table from oss-security-check]

### MCP-Specific Findings

**Tools exposed:** [count] ([list read/write/execute breakdown])
**Transport:** stdio | SSE | HTTP
**Secrets required:** [list env vars]
**Network listeners:** yes/no
**Privileged execution:** yes/no

### Recommendation
[Combined recommendation factoring both base and MCP-specific findings]
```

### 5. User decision

Ask the user:
- **Install** — proceed with installation
- **Install with restrictions** — install but suggest limiting tool access or permissions
- **Abort** — do not install

### 6. Execute the installation

**Prefer source code over registry packages.** Clone the repo, check out a specific tag, build and run locally. This sidesteps npm/PyPI supply chain attacks entirely:

```bash
# Good — clone, audit, pin to tag
cd ~/mcps
git clone https://github.com/author/mcp-server.git
cd mcp-server
git checkout v1.2.3
npm install  # from audited source

# Bad — blind trust in registry
npx @author/mcp-server
```

If the user approved a registry install (npm/pip), ensure versions are pinned in a lock file.

If the recommendation was "medium" or "high" risk:
- Suggest enabling only specific tools, not the full set
- Recommend using read-only credentials where possible
- Note any tools that should be used with confirmation prompts rather than auto-approval

## Notes

- Prefer source-code install at a pinned tag over `npx`/`pip install` to avoid supply chain attacks.
- Complements the `mcp-secure-install` skill if present — use both for defense in depth.
