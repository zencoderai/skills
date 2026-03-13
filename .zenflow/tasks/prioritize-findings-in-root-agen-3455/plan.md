# Auto

## Configuration
- **Artifacts Path**: {@artifacts_path} → `.zenflow/tasks/{task_id}`

---

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:
- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Implementation
<!-- chat-id: 30e49681-3137-46e2-bcb8-adc9dceaacf2 -->

**Goal**: Move priority assignment from subagents to root agent. Subagents return unprioritized findings; root agent filters false-positives and assigns priorities.

**Affected files** (8 total):
- `comprehensive-review/criteria/architecture.md` — remove priority levels from output format
- `comprehensive-review/criteria/bugs.md` — same
- `comprehensive-review/criteria/security.md` — same
- `comprehensive-review/criteria/performance.md` — same
- `comprehensive-review/criteria/code-quality.md` — same
- `comprehensive-review/criteria/requirements-compliance.md` — same
- `comprehensive-review/SKILL.md` — update Step 3 (simple self-review), Step 4 (merge/prioritize), and downstream steps (5-7) to reflect new priority flow
- `comprehensive-review/post-comments.md` — no structural changes needed (receives findings with priorities from root agent)

**Key decisions**:
- Subagents report findings as a flat numbered list — no priority or severity labels at all
- Subagent checklists renamed from "Critical Issues (P0-P1)" to "What to look for — critical issues" etc. for analysis guidance only
- Root agent's Step 4 restructured into substeps: (4a) deduplicate, (4b) filter false-positives, (4c) assign P0-P3 priorities using cross-criteria context, (4d) format output
- Removed verdict (APPROVE/REQUEST CHANGES/NEEDS DISCUSSION) from all subagent output formats — subagents only report findings, no approval decisions
