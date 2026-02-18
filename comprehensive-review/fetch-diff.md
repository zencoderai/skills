# Fetch Diff Subagent

Gather change details, save the diff to a file, and return structured information about the change. Investigate PR data thoroughly to extract the full task description with all requirements.

## Inputs

You will receive:
- **Review mode**: either "PR mode" (with owner, repo, PR number) or "Local mode"

## Workflow

### Step 1: Gather change details and save diff

#### PR mode

1. Fetch PR metadata:
   ```bash
   gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json title,body,commits,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,files,comments
   ```

2. Thoroughly examine the PR to extract the full task description:
   - Read the PR body carefully for requirements, acceptance criteria, and linked issues.
   - If the PR body references an issue (e.g., "Fixes #123", "Closes #456", "Related to #789"), fetch that issue to get the full task description:
     ```bash
     gh issue view <ISSUE_NUMBER> --repo <OWNER>/<REPO> --json title,body,comments
     ```
   - Check PR comments for additional context, clarifications, or updated requirements:
     ```bash
     gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json comments,reviews,reviewRequests
     ```
   - Look at commit messages for additional intent details:
     ```bash
     gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json commits
     ```
   - Combine all gathered information into a comprehensive task description that includes all requirements, constraints, and acceptance criteria.

3. Save the diff:
   ```bash
   gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO> > /tmp/review-diff-<branch-name>.patch
   ```

4. Checkout the correct branch. Try the following strategies in order until one succeeds:

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

3. Gather task description from commit messages on the branch:
   ```bash
   git log --format="%s%n%b" $MERGE_BASE..HEAD
   ```

### Step 2: Check for requirements in the diff

Look at the list of changed files. If any `.md` files are present in the diff, read their contents as they may contain requirements or design docs that provide additional context.

## Required Output

Return the following structured information:

1. **Diff file path**: The absolute path to the saved diff file (e.g., `/tmp/review-diff-<branch-name>.patch`)
2. **Title**: The PR title (PR mode) or a summary derived from commit messages (local mode)
3. **Description**: A comprehensive task description that combines all gathered requirements, acceptance criteria, constraints, and context. This should be thorough enough for reviewers to understand the full intent of the change.

Format your response exactly as:

```
## <title>

### Description
<task description>

### Diff
<link to file containing the diff
```
