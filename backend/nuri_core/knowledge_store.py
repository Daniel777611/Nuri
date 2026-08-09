"""2 知识与决策模型 — retrieval.

The three evidence stores this subsystem reads, and the embedding and chunking
that fill them:

  * `internal`  operator-authored guidance, treated as must-follow when it
                matches the question. Ingested by
                backend/scripts/ingest_internal_docs.py.
  * `pdf`       reference books behind /admin/books and /ask. Reference only —
                NURI may draw on it, but it does not override anything.
  * the web     allow-listed live pages, which live in backend/websearch.py
                because they need no vector store at all.

Split from `knowledge.py`, which decides *whether* a turn needs any of this.
That split is the point: the decision is cheap and testable without a model,
and the retrieval is neither.

Every function degrades to empty rather than raising. A vector store that is
down must cost a turn its citations, not its reply.
"""

from __future__ import annotations

import io
from typing import List, Optional

# A store raising an HTTP status is a layering seam this refactor has not
# reached yet: /index, /ask and /admin/books all rely on the 503 reaching
# the client unchanged. It becomes a domain error once those routes move
# out of main.py.
from fastapi import HTTPException

from backend import runtime
from backend.runtime import (
    EMBED_DIM,
    INTERNAL_MIN_SIMILARITY,
    INTERNAL_NAMESPACE,
    INTERNAL_TOP_K,
    OPENAI_FAST_TIMEOUT_S,
    PdfReader,
    VECTOR_NAMESPACE,
    VECTOR_TABLE,
    oai,
)

def read_pdf(pdf_bytes: bytes) -> str:
    if PdfReader is None:
        raise HTTPException(503, "pypdf not installed")
    reader = PdfReader(io.BytesIO(pdf_bytes))
    text = "\n".join(p.extract_text() or "" for p in reader.pages)
    return text.replace("\x00", "")  # postgres text columns reject NUL bytes

def chunk_text(text: str, size: int = 1200, overlap: int = 150) -> List[str]:
    text = text.replace("\r\n", "\n")
    chunks, start, n = [], 0, len(text)
    while start < n:
        end = min(start + size, n)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == n:
            break
        start = max(0, end - overlap)
    return chunks

def embed_batch(texts: List[str]) -> List[List[float]]:
    # Ingest-time only, and batches can be large — keep the longer client default.
    resp = oai.embeddings.create(model="text-embedding-3-large", input=texts, dimensions=EMBED_DIM)
    return [d.embedding for d in resp.data]

def embed_one(text: str) -> List[float]:
    resp = oai.embeddings.create(
        model="text-embedding-3-large", input=text, dimensions=EMBED_DIM,
        timeout=OPENAI_FAST_TIMEOUT_S,
    )
    return resp.data[0].embedding

def is_indexed(doc_id: str, namespace: str = VECTOR_NAMESPACE):
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = (
        sb.table(VECTOR_TABLE)
        .select("id", count="exact")
        .eq("namespace", namespace)
        .eq("doc_id", doc_id)
        .limit(1)
        .execute()
    )
    total = int(getattr(res, "count", 0) or 0)
    return total > 0, total or None

def upsert_doc(doc_id: str, chunks: List[str], namespace: str = VECTOR_NAMESPACE, extra_metadata: Optional[dict] = None) -> int:
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    vecs_data = embed_batch(chunks)
    base_meta = extra_metadata or {}
    rows = [
        {
            "id": f"{doc_id}-{i}",
            "namespace": namespace,
            "doc_id": doc_id,
            "chunk_id": i,
            "content": c,
            "embedding": v,
            "metadata": {**base_meta, "doc_id": doc_id, "chunk_id": i},
        }
        for i, (c, v) in enumerate(zip(chunks, vecs_data))
    ]
    for start in range(0, len(rows), 100):
        sb.table(VECTOR_TABLE).upsert(rows[start:start + 100], on_conflict="id").execute()
    return len(chunks)

def retrieve(question: str, top_k: int, doc_id: Optional[str]):
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")

    # When no specific doc requested, restrict to enabled books only.
    enabled_doc_ids = None
    if doc_id is None:
        try:
            books_res = sb.table("books").select("doc_id").eq("enabled", True).execute()
            rows = getattr(books_res, "data", None) or []
            if rows:
                enabled_doc_ids = [r["doc_id"] for r in rows]
            # If books table is empty / missing, enabled_doc_ids stays None → search all.
        except Exception:
            pass

    qv = embed_one(question)
    res = sb.rpc(
        "match_rag_chunks",
        {
            "query_embedding": qv,
            "match_count": top_k,
            "filter_doc_id": doc_id,
            "filter_doc_ids": enabled_doc_ids,
            "filter_namespace": VECTOR_NAMESPACE,
        },
    ).execute()
    matches = getattr(res, "data", None) or []
    chunks, scores = [], []
    for m in (matches or []):
        text = (m or {}).get("content", "")
        if text:
            chunks.append(text)
            scores.append(float((m or {}).get("similarity", 0)))
    return chunks, scores

def retrieve_internal(question: str, top_k: int = INTERNAL_TOP_K):
    """Top-k similarity search over the internal (must-follow) namespace.
    Unlike retrieve, there's no books/enabled gating — every ingested
    internal doc is eligible. Matches below INTERNAL_MIN_SIMILARITY are
    dropped so an off-topic message doesn't drag in unrelated internal
    guidance mislabeled as mandatory."""
    sb = runtime.get_supabase()
    if not sb or not oai:
        return [], []
    qv = embed_one(question)
    # No filter_doc_ids here (unlike retrieve): internal docs have no
    # books-style enable/disable toggle, every ingested doc is eligible.
    res = sb.rpc(
        "match_rag_chunks",
        {
            "query_embedding": qv,
            "match_count": top_k,
            "filter_doc_id": None,
            "filter_namespace": INTERNAL_NAMESPACE,
        },
    ).execute()
    matches = getattr(res, "data", None) or []
    chunks, scores = [], []
    for m in (matches or []):
        score = float((m or {}).get("similarity", 0))
        text = (m or {}).get("content", "")
        if text and score >= INTERNAL_MIN_SIMILARITY:
            chunks.append(text)
            scores.append(score)
    return chunks, scores

def internal_rules_ctx(question: str, top_k: int = INTERNAL_TOP_K) -> str:
    if not question or not question.strip():
        return ""
    try:
        chunks, _ = retrieve_internal(question, top_k)
    except Exception as e:
        print(f"[warn] internal_rules_ctx: {e}")
        return ""
    if not chunks:
        return ""
    body = "\n\n".join(f"[內部準則 {i+1}]\n{c}" for i, c in enumerate(chunks))
    return ("以下是內部知識庫中與本次對話相關的準則，必須嚴格遵守，其優先級高於任何外部參考文獻、書籍引用，"
            "以及你自身的一般知識。若內部準則與其他資料衝突，一律以內部準則為準：\n" + body)
