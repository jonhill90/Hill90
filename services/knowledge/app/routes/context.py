"""Context summary assembly route."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request


router = APIRouter(prefix="/api/v1/context", tags=["context"])

# Rough token estimation: ~4 chars per token
CHARS_PER_TOKEN = 4

# Budget allocation per section type (tokens)
SECTION_BUDGETS = {
    "context": 500,
    "journal": 500,
    "plan": 500,
    "decision": 500,
}


def _estimate_tokens(text: str) -> int:
    return len(text) // CHARS_PER_TOKEN


def _truncate_to_tokens(text: str, max_tokens: int) -> str:
    max_chars = max_tokens * CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "..."


@router.get("")
async def get_context(request: Request) -> dict:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    budget = request.app.state.settings.context_token_budget

    sections: list[dict] = []
    total_tokens = 0

    # 1. context.md (top priority)
    context_row = await pool.fetchrow(
        """SELECT id, path, title, entry_type, body
           FROM knowledge_entries
           WHERE agent_id = $1 AND entry_type = 'context' AND status = 'active'
           ORDER BY updated_at DESC LIMIT 1""",
        claims.sub,
    )
    if context_row:
        text = _truncate_to_tokens(context_row["body"], SECTION_BUDGETS["context"])
        tokens = _estimate_tokens(text)
        sections.append({
            "type": "context",
            "entry_id": str(context_row["id"]),
            "path": context_row["path"],
            "title": context_row["title"],
            "content": text,
            "tokens": tokens,
        })
        total_tokens += tokens

    # 2. Recent journals (last 3 days)
    three_days_ago = datetime.now(timezone.utc) - timedelta(days=3)
    journal_rows = await pool.fetch(
        """SELECT id, path, title, entry_type, body
           FROM knowledge_entries
           WHERE agent_id = $1 AND entry_type = 'journal' AND status = 'active'
             AND updated_at >= $2
           ORDER BY updated_at DESC LIMIT 5""",
        claims.sub,
        three_days_ago,
    )
    remaining_journal_budget = SECTION_BUDGETS["journal"]
    for row in journal_rows:
        if remaining_journal_budget <= 0:
            break
        text = _truncate_to_tokens(row["body"], remaining_journal_budget)
        tokens = _estimate_tokens(text)
        sections.append({
            "type": "journal",
            "entry_id": str(row["id"]),
            "path": row["path"],
            "title": row["title"],
            "content": text,
            "tokens": tokens,
        })
        total_tokens += tokens
        remaining_journal_budget -= tokens

    # 3. Active plans
    plan_rows = await pool.fetch(
        """SELECT id, path, title, entry_type, body
           FROM knowledge_entries
           WHERE agent_id = $1 AND entry_type = 'plan' AND status = 'active'
           ORDER BY updated_at DESC LIMIT 5""",
        claims.sub,
    )
    remaining_plan_budget = SECTION_BUDGETS["plan"]
    for row in plan_rows:
        if remaining_plan_budget <= 0:
            break
        text = _truncate_to_tokens(row["body"], remaining_plan_budget)
        tokens = _estimate_tokens(text)
        sections.append({
            "type": "plan",
            "entry_id": str(row["id"]),
            "path": row["path"],
            "title": row["title"],
            "content": text,
            "tokens": tokens,
        })
        total_tokens += tokens
        remaining_plan_budget -= tokens

    # 4. Shared decisions (last 7 days)
    seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
    decision_rows = await pool.fetch(
        """SELECT id, path, title, entry_type, body
           FROM knowledge_entries
           WHERE agent_id = $1 AND entry_type = 'decision' AND status = 'active'
             AND updated_at >= $2
           ORDER BY updated_at DESC LIMIT 5""",
        claims.sub,
        seven_days_ago,
    )
    remaining_decision_budget = SECTION_BUDGETS["decision"]
    for row in decision_rows:
        if remaining_decision_budget <= 0:
            break
        text = _truncate_to_tokens(row["body"], remaining_decision_budget)
        tokens = _estimate_tokens(text)
        sections.append({
            "type": "decision",
            "entry_id": str(row["id"]),
            "path": row["path"],
            "title": row["title"],
            "content": text,
            "tokens": tokens,
        })
        total_tokens += tokens
        remaining_decision_budget -= tokens

    return {
        "sections": sections,
        "token_count": total_tokens,
        "token_budget": budget,
    }
