# Copilot Instructions — RAG Demo

This repository is a minimal Retrieval-Augmented Generation (RAG) demo. These notes give an AI coding agent the concrete, discoverable knowledge needed to make productive edits quickly.

Big picture
- Frontend: `app.py` (Streamlit). Posts user question + uploaded PDF to the backend endpoint `/ask_with_file` at http://127.0.0.1:8000/ask_with_file. See [app.py](app.py#L1-L120).
- Backend: `backend/main.py` (FastAPI). Implements `/ask` (mock) and `/ask_with_file` (accepts form fields `question`, `top_k`, and an uploaded `file`, parses PDF bytes with `pypdf`, chunks text, and returns top-K chunks). See [backend/main.py](backend/main.py#L1-L220).
- Ingestion / Storage: `ingest_pdf.py` and `rag_store.py` — chunk PDFs, embed with `SentenceTransformer('all-MiniLM-L6-v2')`, store vectors in ChromaDB via `chromadb.PersistentClient(path=...)` into collection `docs`. See [ingest_pdf.py](ingest_pdf.py#L1-L140) and [rag_store.py](rag_store.py#L1-L80).
- Query + LLM: `rag_query.py` — forms a context from ChromaDB query results and calls OpenAI via the `openai` client; expects `OPENAI_API_KEY` in env (loaded via `.env`). See [rag_query.py](rag_query.py#L1-L140).

Critical workflows (how to run things locally)
- Start backend: `uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000`
- Start frontend UI: `streamlit run app.py`
- Build embeddings (ingest): edit `ingest_pdf.py` `pdf_path` → run `python ingest_pdf.py` to populate `chroma_db`.
- Debug query flow: `python rag_query.py` (ensure `OPENAI_API_KEY` present).

Project-specific conventions & notes
- ChromaDB collection name: `docs` is used consistently across ingestion and query code.
- Metadata keys used for provenance: `source`, `page`, `chunk` (see `ingest_pdf.py` and `rag_store.py`).
- Embedding model: `all-MiniLM-L6-v2` (local `SentenceTransformer`).
- Paths: many files use hard-coded absolute Windows paths (e.g., `E:\projects\rag-demo\chroma_db`, `E:\projects\rag-demo\data\...`). When editing, search for `E:\projects\rag-demo` and replace or make configurable.
- Chunking: different files use different chunk sizes/overlaps:
  - `backend.chunk_text`: chunk_size=1200, overlap=150 (see [backend/main.py](backend/main.py#L1-L120)).
  - `ingest_pdf.chunk_text`: chunk_size=800, overlap=120 (see [ingest_pdf.py](ingest_pdf.py#L1-L40)).
  Note: keep behavior consistent when changing retrieval/ingestion.

Integration points & external deps
- ChromaDB persistent storage: local folder `chroma_db/` (repo contains `chroma_db/chroma.sqlite3`).
- OpenAI: `rag_query.py` uses `OpenAI(api_key=...)` and expects `OPENAI_API_KEY`. `.env` is loaded via `dotenv`.

Known quirks & quick fixes (actionable)
- `backend/main.py` contains a likely bug: helper named `exact_text_from_pdf_path` but `ask()` calls `extract_text_from_pdf_path` (typo). Fix by aligning the names.
- `backend.ask()` currently uses a hard-coded `pdf_path` and returns mock data; production flow uses `/ask_with_file` which accepts uploads — prefer that route for real inputs.
- `requirements.txt` currently lists `streamlit`, `fastapi`, `uvicorn`, `requests` but the code also requires: `sentence_transformers`, `chromadb`, `pypdf`, `python-dotenv`, and `openai` / compatible client. Install these when working on embeddings/queries.

Concrete examples for agent edits
- To wire a change in retrieval size: update both `ingest_pdf.chunk_text` and `backend.chunk_text` to the same `chunk_size`/`overlap`.
- To switch the DB path to relative: replace hard-coded paths with `os.path.join(os.path.dirname(__file__), '..', 'chroma_db')` and update `PersistentClient(path=...)` accordingly (used in `ingest_pdf.py`, `rag_store.py`, `rag_query.py`).
- To test end-to-end locally: start `uvicorn` (backend), run `streamlit run app.py`, upload a PDF in the UI and confirm the frontend calls `/ask_with_file` and returns chunks.

If anything here is unclear or you want additional sections (tests, CI, or a sample `.env`), tell me which part to expand and I will iterate.
