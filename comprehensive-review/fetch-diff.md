# Fetch Diff Subagent

Gather change details, save the diff to a file, and return structured information about the change. The task description must only be derived from: PR description, PR comments, commit messages, and committed `.md` files. Never infer the description from code changes.

## Inputs

You will receive:
- **Mode**: either "PR mode" (with owner, repo, PR number) or "Local mode"

## Workflow

### Step 1: Gather change details and save diff

#### PR mode

1. Fetch PR metadata:
   ```bash
   gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json title,body,commits,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,files,comments
   ```

2. Checkout the correct branch. Try the following strategies in order until one succeeds:

   a. **`gh pr checkout`** (preferred):
      ```bash
      gh pr checkout <PR_NUMBER> --repo <OWNER>/<REPO>
      ```

   b. **Fetch by branch name** (if `gh pr checkout` fails):
      ```bash
      git fetch origin <headRefName> && git checkout <headRefName> && git pull origin <headRefName>
      ```

   c. **Fetch by commit SHA** (if the branch was deleted or renamed):
      ```bash
      git fetch origin <headRefOid> && git checkout <headRefOid>
      ```

   If all strategies fail, include an error in your response.

3. Extract the task description from the following sources only (never infer from code):
   - **PR description**: Read the PR body for requirements, acceptance criteria, and context.
   - **PR comments**: Check PR comments for additional context, clarifications, or updated requirements:
     ```bash
     gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json comments,reviews,reviewRequests
     ```
   - **Commit messages**: Look at commit messages for additional intent details:
     ```bash
     gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json commits
     ```
   - **Committed `.md` files**: Check the list of changed files from PR metadata. If any `.md` files are present, read their full committed contents as they may contain requirements or design docs.
   - Combine the PR description, PR comments, commit messages, and any committed `.md` files into a comprehensive task description. Do not supplement with information inferred from the code diff.

4. Save the diff:
   ```bash
   gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO> > /tmp/review-diff-<branch-name>.patch
   ```

#### Local mode

1. Detect the current branch and its merge base:
   ```bash
   CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
   BASE_BRANCH=$(git log --oneline --merges --ancestry-path HEAD..$(git remote show origin | grep 'HEAD branch' | awk '{print $NF}') 2>/dev/null | tail -1 | cut -d' ' -f1 || echo "main")
   ```
   If detecting the base branch fails, try common defaults (`main`, `master`, `develop`).

2. Generate a combined diff:
   ```bash
   MERGE_BASE=$(git merge-base HEAD origin/<BASE_BRANCH>)
   git diff $MERGE_BASE HEAD > /tmp/review-diff-committed-<branch-name>.patch
   git diff > /tmp/review-diff-uncommitted-<branch-name>.patch
   cat /tmp/review-diff-committed-<branch-name>.patch /tmp/review-diff-uncommitted-<branch-name>.patch > /tmp/review-diff-<branch-name>.patch
   ```

3. Gather task description from commit messages on the branch (do not infer from code):
   ```bash
   git log --format="%s%n%b" $MERGE_BASE..HEAD
   ```

### Step 2: Check for requirements in committed `.md` files

Look at the list of changed files. If any `.md` files are present in the diff, read their full committed contents as they may contain requirements or design docs that are part of the task description.

### Step 3: Assess complexity

Evaluate the PR complexity based on the diff and metadata gathered above. **Only consider changes to code** — exclude test files (e.g., `*_test.*`, `*.test.*`, `*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`) and documentation files (e.g., `*.md`) when counting lines changed and files changed.

Use the PR metadata (additions, deletions, changedFiles, files list) for quantitative assessment — filter out test and documentation files from the counts using the file paths in the metadata. Do NOT read the full diff file to assess complexity; the file list and line counts from metadata are sufficient for this step. The qualitative assessment should be based on the nature of the changed files (their paths and roles in the system), not on reading the diff content.

#### Baseline classification (size-based, secondary criterion)

Use line counts and file counts as a **starting point only**:

- **simple baseline**: ≤ 100 lines of implementation code changed across ≤ 3 non-test/non-doc files, single concern (e.g., bug fix, config tweak, copy change, dependency bump, simple refactor).
- **medium baseline**: 100–500 lines of implementation code changed or 4–10 non-test/non-doc files, may touch multiple modules but follows a clear pattern (e.g., adding a new endpoint, refactoring a module, implementing a straightforward feature).
- **hard baseline**: > 500 lines of implementation code changed or > 10 non-test/non-doc files.

#### Qualitative signals (primary criterion — override size-based baseline)

After determining the size-based baseline, apply the following qualitative signals. These signals reflect structural and semantic complexity that is independent of diff size — a 50-line change can be "hard" if it triggers these signals, while a 600-line generated migration can remain "simple" if none apply.

**Signals that set the floor to `hard` regardless of size:**

- **New subsystem or framework introduction**: The PR adds (not just modifies) 3+ new non-test files that form a coherent new module spanning architectural layers (e.g., interface + factory + implementation, or SPI + provider + default impl). PR title keywords like "implement", "introduce", "new framework/subsystem" reinforce this signal.
- **Security-critical domain paths**: Changed file paths are in authentication, authorization, token management, OAuth/OIDC, cryptography, permissions, or access control domains. Even a few-line change in these areas can cause privilege escalation or authentication bypasses.
- **Shared infrastructure modification alongside new dependent code**: The PR simultaneously modifies existing shared code (base classes, widely-used utilities, middleware, common managers) AND adds new code that depends on those modifications. The blast radius is compounded — shared modification may regress existing callers while new code introduces its own bugs.

**Signals that bump complexity up by one tier** (simple→medium, medium→hard):

- **Concurrency and threading primitives**: The PR introduces or modifies code involving threads, locks, queues, atomic operations, `synchronized`, `ExecutorService`, `Future`, `asyncio` concurrency primitives, or the PR title/description mentions race conditions, thread safety, or concurrent access. Concurrency bugs require reasoning about interleaved execution, not just static structure.
- **Cross-file API contract dependencies**: New code calls store/repository/registry lookup APIs where correctness depends on understanding how data was written in non-diff code, or uses field/key lookups (e.g., `validated_data.get("field_name")`) where the key must match a framework's internal mapping conventions. Silent lookup failures from wrong parameters are invisible at the call site.
- **Feature flag / version guard consistency**: The PR wraps existing logic in a new conditional guard (feature flag, profile check, version check, environment variable) where the guard must be consistent with the rest of the class or subsystem — especially when the codebase has multiple versions of the same flag (e.g., `FEATURE_V1` / `FEATURE_V2`).
- **Multi-domain / cross-cutting changes**: Changed implementation files span ≥ 4 distinct product domains or subsystem directories. A mismatch between the PR title's stated scope and the actual breadth of changed files is a strong reinforcing signal — it indicates bundled independent concerns that each need full review attention.
- **Interface or abstract contract changes with scattered implementations**: The PR modifies a shared interface, abstract class, type declaration, or base class method that has multiple concrete implementations — especially when not all implementations are updated in the same PR. Also applies to `@Override` methods with changed return semantics (e.g., introducing `null` where non-null was previously guaranteed).
- **API response or error contract mutations**: Changed files include endpoint handlers or serializer classes where existing response structures are modified or removed — changed field names, added/removed response body on previously-empty responses, changed status codes or content types. These are breaking changes whose impact is invisible within the diff.

#### Final classification

Combine the size-based baseline with qualitative signals to produce the final classification. Qualitative signals always take precedence — if any "floor to hard" signal is present, classify as **hard**. If any "bump one tier" signal is present, increase the baseline by one level. Multiple bump signals do not stack beyond **hard**.

## Required Output

Return the following structured information:

1. **Diff file path**: The absolute path to the saved diff file (e.g., `/tmp/review-diff-<branch-name>.patch`). MUST be an absolute path starting with `/`.
2. **Diff line count**: The total number of lines in the diff file. After saving the diff, run `wc -l < <diff-file-path>` to get this count.
3. **Title**: The PR title (PR mode) or a summary derived from commit messages (local mode)
4. **Description**: A comprehensive task description derived only from the PR description, PR comments, commit messages, and committed `.md` files. Never infer or supplement the description from the code diff. This should be thorough enough for reviewers to understand the full intent of the change.
5. **Complexity**: One of `simple`, `medium`, or `hard`

Format your response exactly as:

```
## <title>

### Description
<task description>

### Complexity
<simple|medium|hard>

### Diff
<absolute path to the diff file, e.g. /tmp/review-diff-feature.patch>

### Diff Line Count
<total number of lines in the diff file>
```
