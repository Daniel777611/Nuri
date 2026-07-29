"""
backend/scripts/ingest_internal_docs.py

Standalone ingestion pipeline for the "internal" RAG partition — NURI-authored
parenting guidance that the system prompt treats as mandatory rules, distinct
from the "external" namespace (VECTOR_NAMESPACE, default 'pdf') used for
reference-only books managed through /admin/books.

This intentionally does NOT touch the `books` table: internal docs have no
per-doc enable/disable toggle and aren't shown in the admin books UI. Every
chunk that lands under INTERNAL_NAMESPACE in rag_chunks is always eligible
for retrieval (see main._retrieve_internal).

Usage:
    python backend/scripts/ingest_internal_docs.py [folder ...]

    With no arguments, ingests every PDF under <repo_root>/internelDatabase/
    (recursively, so both the 0701/ and 0728/ subfolders are covered).

doc_id is a sha1 hash of the file bytes (same scheme as the external /index
route), so re-running this script is idempotent: unchanged files are skipped,
and editing a file's content produces a new doc_id rather than silently
clobbering the old chunks.
"""
import hashlib
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/

import main as backend_main  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE_DIR = REPO_ROOT / "internelDatabase"


def _iter_pdfs(folders: list[Path]):
    for folder in folders:
        yield from sorted(folder.rglob("*.pdf"))


def ingest_file(path: Path) -> None:
    pdf_bytes = path.read_bytes()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]

    already, total = backend_main._is_indexed(doc_id, namespace=backend_main.INTERNAL_NAMESPACE)
    if already:
        print(f"[skip] {path.name} (doc_id={doc_id}, already indexed, {total} chunks)")
        return

    text = backend_main._read_pdf(pdf_bytes)
    if not text.strip():
        print(f"[warn] {path.name}: no extractable text, skipping")
        return
    chunks = backend_main._chunk_text(text)
    total = backend_main._upsert_doc(
        doc_id, chunks,
        namespace=backend_main.INTERNAL_NAMESPACE,
        extra_metadata={"source_file": path.name, "source_folder": path.parent.name},
    )
    print(f"[ok] {path.name} -> doc_id={doc_id}, {total} chunks")


def main() -> None:
    if not backend_main._get_supabase():
        print("Supabase not configured (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Aborting.")
        sys.exit(1)
    if not backend_main.oai:
        print("OpenAI not configured (check OPENAI_API_KEY). Aborting.")
        sys.exit(1)

    args = sys.argv[1:]
    folders = [Path(a).resolve() for a in args] if args else [DEFAULT_SOURCE_DIR]
    for f in folders:
        if not f.is_dir():
            print(f"[error] not a directory: {f}")
            sys.exit(1)

    pdfs = list(_iter_pdfs(folders))
    if not pdfs:
        print(f"No PDFs found under {[str(f) for f in folders]}")
        return

    print(f"Found {len(pdfs)} PDF(s) under {[str(f) for f in folders]}. Namespace: {backend_main.INTERNAL_NAMESPACE}")
    for path in pdfs:
        ingest_file(path)


if __name__ == "__main__":
    main()
