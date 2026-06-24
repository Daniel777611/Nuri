"""
backend.main

This is the backend API for the RAG demo. It provides endpoints to:
- Index PDFs: extract text, chunk, embed, and upsert to Pinecone with a marker vector for idempotency.
- Ask questions: retrieve relevant chunks from Pinecone and generate answers using OpenAI.

Key features:
- Idempotent indexing: uses a marker vector to track if a document has already been indexed
- Async FastAPI endpoints with anyio to run blocking operations in threads
- CORS enabled for frontend integration
- Environment variables for configuration

To run:
1. Set up your environment variables in a .env file (OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX)
2. Install dependencies: pip install -r requirements.txt
3. Start the server: uvicorn backend.main:app --reload


"""
import io
import os
import hashlib
from typing import Optional, List, Tuple
import anyio
from dotenv import load_dotenv
from openai import OpenAI
from fastapi import FastAPI, UploadFile, File
from pydantic import BaseModel
from pypdf import PdfReader
from pinecone import Pinecone
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # adjust in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Env
# ----------------------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX = os.getenv("PINECONE_INDEX")         # nasmrag
PINECONE_NAMESPACE = os.getenv("PINECONE_NAMESPACE", "pdf")

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")
if not PINECONE_API_KEY:
    raise RuntimeError("PINECONE_API_KEY is not set")
if not PINECONE_INDEX:
    raise RuntimeError("PINECONE_INDEX is not set")

# CHANGED: define embedding dim once (must match your Pinecone index dimension)
EMBED_DIM = 1024

# client
oai = OpenAI(api_key=OPENAI_API_KEY)
pc = Pinecone(api_key=PINECONE_API_KEY)

# find host based on list_indexes (pinecone v9 returns IndexModel objects, not dicts)
indexes = pc.list_indexes()
host = None
for idx in indexes:
    idx_name = idx.get("name") if isinstance(idx, dict) else getattr(idx, "name", None)
    idx_host = idx.get("host") if isinstance(idx, dict) else getattr(idx, "host", None)
    if idx_name == PINECONE_INDEX:
        host = idx_host
        break
if not host:
    raise RuntimeError(f"Index '{PINECONE_INDEX}' not found in this Pinecone project.")

pine_index = pc.Index(host=host)

# ----------------------------
# Utils
# ----------------------------
def read_pdf_bytes_to_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages = [(p.extract_text() or "") for p in reader.pages]
    return "\n".join(pages)

def chunk_text(text: str, chunk_size: int = 1200, overlap: int = 150) -> List[str]:
    text = text.replace("\r\n", "\n")
    chunks: List[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + chunk_size, n)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == n:
            break
        start = max(0, end - overlap)
    return chunks

def embed_1024(texts: List[str]) -> List[List[float]]:
    resp = oai.embeddings.create(
        model="text-embedding-3-large",
        input=texts,
        dimensions=EMBED_DIM,
    )
    return [d.embedding for d in resp.data]

def embed_query(text: str) -> List[float]:
    resp = oai.embeddings.create(
        model="text-embedding-3-large",
        input=text,
        dimensions=EMBED_DIM,
    )
    return resp.data[0].embedding

def marker_id_for(doc_id: str) -> str:
    return f"{doc_id}::marker"

def make_marker_vector(dim: int) -> List[float]:
    # CHANGED: Pinecone dense vectors cannot be all-zero. Must contain >=1 non-zero value.
    v = [0.0] * dim
    v[0] = 1e-6  # tiny non-zero value, won’t affect similarity usage (we never query marker anyway)
    return v

def _fetch_vectors_dict(fetch_res) -> dict:
    # handle both dict-like and object-like responses from pinecone grpc
    if isinstance(fetch_res, dict):
        return fetch_res.get("vectors", {}) or {}
    return getattr(fetch_res, "vectors", {}) or {}

def _vector_metadata(vec_obj) -> dict:
    # handle both dict-like and object-like vector entries
    if isinstance(vec_obj, dict):
        return vec_obj.get("metadata", {}) or {}
    return getattr(vec_obj, "metadata", {}) or {}

def is_already_indexed(doc_id: str) -> Tuple[bool, Optional[int]]:
    mid = marker_id_for(doc_id)
    res = pine_index.fetch(ids=[mid], namespace=PINECONE_NAMESPACE)
    vectors = _fetch_vectors_dict(res)

    if mid in vectors:
        md = _vector_metadata(vectors[mid])
        total = md.get("total_chunks")
        return True, total

    return False, None

def upsert_doc_with_marker(doc_id: str, chunks: List[str]) -> int:
    # embed + upsert normal chunks
    vecs = embed_1024(chunks)

    vectors = []
    for i, (c, v) in enumerate(zip(chunks, vecs)):
        vectors.append({
            "id": f"{doc_id}-{i}",
            "values": v,
            "metadata": {"text": c, "doc_id": doc_id, "chunk_id": i},
        })

    # CHANGED: marker vector must be NON-ZERO or Pinecone throws 500
    vectors.append({
        "id": marker_id_for(doc_id),
        "values": make_marker_vector(EMBED_DIM),  # ✅ fixed
        "metadata": {"doc_id": doc_id, "is_marker": True, "total_chunks": len(chunks)},
    })

    pine_index.upsert(vectors=vectors, namespace=PINECONE_NAMESPACE)
    return len(chunks)

def retrieve_chunks(question: str, top_k: int, doc_id: Optional[str]) -> Tuple[List[str], List[float]]:
    qv = embed_query(question)

    #kwargs is dict to hold query parameters, we conditionally add filter if doc_id is provided
    query_kwargs = dict(
        namespace=PINECONE_NAMESPACE,
        vector=qv,
        top_k=top_k,
        include_metadata=True,
    )
    if doc_id:
        query_kwargs["filter"] = {"doc_id":  {"$eq": doc_id}}

    res = pine_index.query(**query_kwargs)

    # ---- normalize matches for both dict-like and object-like responses
    if hasattr(res, "matches"):
        matches = res.matches or []
        # object-style match
        chunks = []
        scores = []
        for m in matches:
            md = getattr(m, "metadata", None) or {}
            text = md.get("text", "")
            if text:
                chunks.append(text)
                scores.append(float(getattr(m, "score", 0.0) or 0.0))
        return chunks, scores

    # dict-style response
    matches = res.get("matches", []) if isinstance(res, dict) else []
    chunks = []
    scores = []
    for m in matches:
        text = (m.get("metadata", {}) or {}).get("text", "")
        if text:
            chunks.append(text)
            scores.append(float(m.get("score", 0.0) or 0.0))
    return chunks, scores

NURI_PERSONA = """你叫 NURI，是一位專業且溫暖的育兒夥伴，而非提供標準答案的專家。NURI 的知識基礎來自兒童發展、心理學、教育學、神經科學、正向教養、依附理論及大量真實家庭經驗。NURI 相信每個孩子、每個家庭都有不同的節奏，因此不追求唯一正確答案，而是透過持續對話，陪伴父母理解孩子、理解自己，一起找到最適合家庭的方式。

第一次互動時，NURI 會進行自我介紹，之後不再重複自己的名字。

當遇到明確育兒問題時，NURI 會先根據廣泛研究提供一版初步策略，並清楚說明這只是第一版方向，之後會隨著對話持續修正。所有正式策略固定使用六個部分呈現：背景分析、專業知識解釋、建議方案 A/B/C、論文與書籍來源、相似家庭經驗、下一步引導。

NURI 不急於給出結論，而是透過每次只詢問 1～2 個問題，逐步了解孩子年齡、氣質、個性、家庭結構、生活型態、父母價值觀、壓力來源以及過去嘗試過的方法，並在約 4～5 輪對話後重新整合並更新策略。

NURI 將每一次對話視為持續陪伴的一部分，會記住過去的討論內容，將孩子的特質、家庭背景、父母的育兒理念、曾經有效或無效的方法作為未來策略的背景參考，而不是每次重新開始。

當使用者沒有提出明確問題時，NURI 會進入陪伴模式，不急著分析或提供方法，而是自然聊天、提供情緒支持、了解媽媽的近況、孩子的成長與家庭生活，讓使用者感受到被理解與陪伴。

NURI 的語氣溫暖、自然、專業但不武斷，不使用重複、制式或過度安慰的句型，不將孩子視為問題，也不要求完美父母。NURI 尊重父母的價值觀，不替父母做決定，而是以「理解先於建議」為核心，透過長期關係與持續修正，陪伴家庭一起成長。

最重要的信念是：每一版策略都只是目前最適合這個家庭的版本，而不是放諸四海皆準的標準答案；NURI 的角色不是替父母解決所有問題，而是陪伴父母一起理解孩子、理解自己，並在每個成長階段找到屬於自己的方法。"""

def generate_answer(question: str, chunks: List[str], book_name: Optional[str] = None) -> str:
    context = "\n\n".join([f"[Chunk {i+1}]\n{c}" for i, c in enumerate(chunks)])

    if book_name:
        citation_note = '\n在回答結束時，另起一行，僅引用上方參考文獻中明確出現的理論或概念名稱，格式為：參考自「[文獻中出現的理論或概念名稱]」理論。若文獻未明確提及任何理論名稱，則省略此行。'
    else:
        citation_note = ""

    system_content = (
        NURI_PERSONA
        + "\n\n以下是本次對話的參考文獻節錄，可作為輔助依據。NURI 應優先運用自身的兒童發展與育兒專業知識作答，文獻內容僅供參考補充。無論文獻是否涵蓋問題，都請盡力提供有幫助的回應，避免直接回答「我不知道」或「抱歉，我無法回答」。\n"
        + citation_note
    )

    resp = oai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_content},
            {"role": "user", "content": f"問題：{question}\n\n參考文獻：\n{context}"},
        ],
        temperature=0.7,
    )
    return resp.choices[0].message.content

# ----------------------------
# Models
# ----------------------------
class AskRequest(BaseModel):
    question: str
    top_k: int = 5
    doc_id: Optional[str] = None
    book_name: Optional[str] = None

# ----------------------------
# Endpoints (async)
# ----------------------------
@app.get("/")
async def root():
    return {
        "msg": "RAG backend is running",
        "endpoints": ["/health", "/index", "/ask", "/docs"]
    }

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/index")
async def index_pdf(file: UploadFile = File(...)):
    # 1) read bytes (fast, ok in async)
    pdf_bytes = await file.read()

    # 2) compute stable doc_id
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]

    # idempotent check - if marker exists, skip re-indexing
    already, total = await anyio.to_thread.run_sync(is_already_indexed, doc_id)
    if already:
        return {
            "doc_id": doc_id,
            "total_chunks": total,
            "namespace": PINECONE_NAMESPACE,
            "already_indexed": True,
        }

    # 3) extract + chunk (CPU-bound, run in thread)
    text = await anyio.to_thread.run_sync(read_pdf_bytes_to_text, pdf_bytes)
    chunks = await anyio.to_thread.run_sync(chunk_text, text)

    # 4) upsert (network + compute, run in thread)
    total_chunks = await anyio.to_thread.run_sync(upsert_doc_with_marker, doc_id, chunks)

    return {
        "doc_id": doc_id,
        "total_chunks": total_chunks,
        "namespace": PINECONE_NAMESPACE,
        "already_indexed": False,
    }

@app.post("/ask")
async def ask(req: AskRequest):
    # run retrieval + generation in threads (OpenAI/Pinecone calls are blocking)
    chunks, scores = await anyio.to_thread.run_sync(retrieve_chunks, req.question, req.top_k, req.doc_id)
    answer = await anyio.to_thread.run_sync(generate_answer, req.question, chunks, req.book_name)
    return {"answer": answer, "chunks": chunks, "scores": scores}
