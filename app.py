"""
app.py

Frontend entry point for the RAG demo application.

This file defines the Streamlit-based user interface, allowing users to:
- upload PDFs and index them via the backend,
- ask questions
- receive answers from openAi API based on the indexed content in the backend.

The frontend interacts witha FastAPI backend deployed on Render.com.
"""
import os
import hashlib
import streamlit as st
from pathlib import Path
import requests
from dotenv import load_dotenv

load_dotenv()
# ----------------------------
# Configuration
# set_page_config should be called only once, at the beginning
# its purpose is to set the title and layout of the Streamlit app
# ----------------------------
st.set_page_config(page_title="My RAG App", layout="wide")

AVAILABLE_BOOKS = {
    "CHDV 100: Child Development (2020)": Path("data/CHDV-100-OER-Textbook-updatedJuly2020.pdf"),
    "NASM CPT7 Study Guide": Path("data/NASM_CPT7_Study_Guide.pdf"),
}

# API_BAse points to deployed FastAPI backend(Render)
API_BASE = os.getenv("API_BASE", "https://nasm-rag.onrender.com")
ASK_URL = f"{API_BASE}/ask"
INDEX_URL = f"{API_BASE}/index"

# ----------------------------
# UI
# ----------------------------
st.title("RAG Demo")
st.caption("Upload PDF → index via backend → ask questions via backend")

# [Strict file based] This sections support openai only generate based on target PDF  
if "indexed_docs" not in st.session_state:
    st.session_state["indexed_docs"] = set()

# Store active_doc_id for filtering backend retrieval
if "active_doc_id" not in st.session_state:
    st.session_state["active_doc_id"] = None

# avoid repeat indexing the same doc_id 
if "doc_map" not in st.session_state:
    st.session_state["doc_map"] = {}

# -----------------------------
# Chat state
# -----------------------------
if "messages" not in st.session_state:
    # Each message: {"role": "user"|"assistant", "content": "..."}
    st.session_state["messages"] = [
        {"role": "assistant", "content": "Hello! I'm your RAG assistant. Please upload a PDF and ask me anything about it. "}
    ]

# Store last retrieved chunks from backend
if "last_retrieved" not in st.session_state:
    st.session_state["last_retrieved"] = []

# -----------------------------
# Sidebar: Settings + 教材选择
# -----------------------------
with st.sidebar:
    st.header("Settings")
    top_k = st.slider("Top K", 1, 10, 5)
    st.divider()
    st.subheader("教材选择")
    _available = {t: p for t, p in AVAILABLE_BOOKS.items() if p.exists()}
    if _available:
        selected_title = st.selectbox("选择教材", list(_available.keys()))
    else:
        selected_title = None
        st.warning("data/ 目录下未找到教材文件")

# -----------------------------
# PDF 加载：优先使用侧边栏选择，上传器用于自定义 PDF
# -----------------------------
uploaded = st.file_uploader("上传自定义 PDF（可选）", type=["pdf"])

pdf_bytes = None
doc_id = None
filename = None
source = None  # "upload" or "default"

if uploaded is not None:
    pdf_bytes = uploaded.read()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]
    filename = uploaded.name
    source = "upload"
elif selected_title and selected_title in _available:
    selected_path = _available[selected_title]
    pdf_bytes = selected_path.read_bytes()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]
    filename = selected_path.name
    source = "default"
    st.info(f"当前教材：{selected_title}")

# -----------------------------
# When user changes PDF, reset backend_doc_id
# avoid asking wrong document by accident
# -----------------------------
if "last_local_doc_id" not in st.session_state:
    st.session_state["last_local_doc_id"] = None

if doc_id != st.session_state["last_local_doc_id"]:
    # PDF changed
    st.session_state["last_local_doc_id"] = doc_id
    st.session_state["active_doc_id"] = None
    st.session_state["last_retrieved"] = []
    # optional: reset chat history if you want
    # st.session_state["messages"] = st.session_state["messages"][:1]
    
# If we indexed this local doc before in this session, reuse backend_doc_id
if doc_id and doc_id in st.session_state["doc_map"]:
    st.session_state["active_doc_id"] = st.session_state["doc_map"][doc_id]


# -----------------------------
# Sidebar info
# -----------------------------
# Show current doc info (if any)
# TODO : hide this message if no PDF loaded
if pdf_bytes is not None:
    st.success(f"Loaded: {filename} | doc_id: {doc_id} | source: {source}")

active_doc_id = st.session_state.get("active_doc_id")
is_indexed = (
    active_doc_id in st.session_state["indexed_docs"]
    if active_doc_id
    else False
)
st.info(f"Active doc_id for retrieval: {active_doc_id} | Indexed in this session: {is_indexed}")

with st.sidebar:
    st.divider()
    st.subheader("Index Status")

    if "last_index_status" in st.session_state:
        s = st.session_state["last_index_status"]

        if s.get("already_indexed"):
            st.info(
                f"Already indexed ✓\n\n"
                f"backend_doc_id: `{s.get('backend_doc_id')}`\n\n"
                f"chunks: {s.get('chunks')}\n\n"
                f"namespace: {s.get('namespace')}"
            )
        else:
            st.success(
                f"Indexed ✓\n\n"
                f"backend_doc_id: `{s.get('backend_doc_id')}`\n\n"
                f"chunks: {s.get('chunks')}\n\n"
                f"namespace: {s.get('namespace')}"
            )
    else:
        st.caption("No indexing performed yet.")

    #Guard moved from prompt section to here because it blocks user further interaction.
    #Guard start
    active_doc_id = st.session_state.get("active_doc_id")
    # serious guard 1：must have active_doc_id 
    # Here prevent me from using default PDF without indexing.
    if not active_doc_id:
         st.info("No PDF indexed in this session. Searching ALL indexed docs in Supabase.")
    # serious guard 2: must haveindex
    if active_doc_id not in st.session_state.get("indexed_docs", set()):
         st.info("No PDF indexed in this session. Searching ALL indexed docs in Supabase.")
    #Guard end

# -----------------------------
# Supabase vector insert button
# optimization: avoid re-indexing the same doc_id
# -----------------------------
if pdf_bytes is not None:
    # If user already indexed current active_doc_id, we can skip.
    # But note: local_doc_id != backend_doc_id; backend decides doc_id.

    # st.info("upload and index a PDF disabled due to render.com free tier limit, please use the default PDF or deploy your own backend to enable this feature.")

    if st.button("Index this PDF to Backend", disabled=False):
        if doc_id in st.session_state["doc_map"]:
            st.warning("This document is already indexed in this session.")
        else:
            with st.spinner("Uploading to backend /index ..."):
                try:
                    r = requests.post(
                        INDEX_URL,
                        files={"file": (filename or "upload.pdf", pdf_bytes, "application/pdf")},
                        timeout=300,
                    )
                except requests.RequestException as e:
                    st.error(f"Index request failed: {e}")
                    st.stop()

            if r.status_code != 200:
                st.error(f"Index failed: {r.status_code} {r.text}")
                st.stop()

            data = r.json()

            backend_doc_id = data.get("doc_id")
            already_indexed = data.get("already_indexed", False)  # ⭐ 新增
            total_chunks = data.get("total_chunks")
            namespace = data.get("namespace")

            # set active_doc_id to backend_doc_id for retrieval filtering
            st.session_state["active_doc_id"] = backend_doc_id

            # mark as indexed
            if backend_doc_id:
                st.session_state["indexed_docs"].add(backend_doc_id)

            # record local_doc_id -> backend_doc_id mapping
            if doc_id and backend_doc_id:
                st.session_state["doc_map"][doc_id] = backend_doc_id

            # store last index status for sidebar display
            st.session_state["last_index_status"] = {
                "local_doc_id": doc_id,
                "backend_doc_id": backend_doc_id,
                "chunks": total_chunks,
                "namespace": namespace,
                "already_indexed": already_indexed,
            }

            # show success message with details
            if already_indexed:
                st.info(
                    f"Already indexed ✓  backend_doc_id={backend_doc_id} | "
                    f"chunks={total_chunks} | namespace={namespace}"
                )
            else:
                st.success(
                    f"Indexed successfully ✓  backend_doc_id={backend_doc_id} | "
                    f"chunks={total_chunks} | namespace={namespace}"
                )

            st.rerun()

# -----------------------------
# Render chat history
# -----------------------------
for msg in st.session_state["messages"]:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

# -----------------------------
# Prompt section
# active_doc_id: 
# -----------------------------
prompt = st.chat_input("Ask a question about the PDF")
if prompt:
    st.sidebar.write("DEBUG: got prompt")
    st.sidebar.write("DEBUG active_doc_id:", st.session_state.get("active_doc_id"))
    st.sidebar.write("DEBUG indexed_docs size:", len(st.session_state.get("indexed_docs", set())))
    
    # 1) print user question in chat history
    st.session_state["messages"].append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)

    # 2) call backend /ask to get answer and retrieved chunks, then print answer in chat history
    with st.chat_message("assistant"):
        # if uploaded is None:
        #     st.warning("Please upload a PDF first, then click 'Index this PDF to Supabase'.")
        #     st.stop()

        # st.spinner is a context manager that shows a spinner while the code inside is running
        with st.spinner("Calling backend /ask ..."):
            try:
                r = requests.post(
                    ASK_URL,
                    json={
                        "question": prompt,
                        "top_k": top_k,
                        "doc_id": st.session_state.get("active_doc_id"),
                        "book_name": filename,
                    },
                    timeout=120,
                )
            except requests.RequestException as e:
                st.error(f"Ask request failed: {e}")
                st.stop()

        if r.status_code != 200:
            st.error(f"Ask failed: {r.status_code} {r.text}")
            st.stop()

        data = r.json()
        answer = data.get("answer", "")
        chunks = data.get("chunks", [])
        scores = data.get("scores", [])

        # saved last chunks for sidebar display
        st.session_state["last_retrieved"] = list(zip(scores, chunks))
        st.markdown(answer)
        st.sidebar.write("DEBUG: generated answer length:", len(answer) if answer else 0)


    # 3) print openai response in chat history
    st.session_state["messages"].append({"role": "assistant", "content": answer})


# -----------------------------
# put last chunks in sidebar
# -----------------------------
with st.sidebar:
    st.divider()
    st.subheader("Last Retrieved Chunks")
    retrieved = st.session_state.get("last_retrieved", [])
    if not retrieved:
        st.caption("No chunks retrieved yet.")
    else:
        for i, (score, text) in enumerate(retrieved, 1):
            with st.expander(f"Chunk #{i} (score: {score:.3f})", expanded=False):
                st.write(text)


