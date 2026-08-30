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

That hash is of the *file*, not of what was extracted from it — so a change to
the extraction or chunking code leaves every doc_id unchanged and this script
skips all of them. Pass --reingest to delete a doc's existing chunks and rebuild
them. That is the flag to use after the CJK radical normalisation landed in
knowledge_store.read_pdf: 93% of the chunks in the internal namespace were
embedded from text where 子 was the Kangxi radical ⼦. Worth about +0.013 top-1
similarity — measured, not assumed — so this is a correctness fix rather than
the answer to the namespace's low hit rate.

    python backend/scripts/ingest_internal_docs.py --reingest
"""
import argparse
import hashlib
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# The repo root, not backend/: main.py imports its own package by absolute
# name ("from backend.nuri_core import ..."), so putting only backend/ on the
# path makes this script fail at import with ModuleNotFoundError: backend.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# The PDF pipeline moved out of main.py into nuri_core/knowledge_store.py and
# runtime.py. Importing those directly keeps this script off the HTTP layer,
# which it never needed and which drags in the whole FastAPI app.
from backend import runtime  # noqa: E402
from backend.nuri_core import knowledge_store  # noqa: E402

DEFAULT_SOURCE_DIR = REPO_ROOT / "internelDatabase"


def _iter_pdfs(folders: list[Path]):
    for folder in folders:
        yield from sorted(folder.rglob("*.pdf"))


def ingest_file(path: Path, reingest: bool = False) -> None:
    pdf_bytes = path.read_bytes()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]

    already, total = knowledge_store.is_indexed(doc_id, namespace=runtime.INTERNAL_NAMESPACE)
    if already and not reingest:
        print(f"[skip] {path.name} (doc_id={doc_id}, already indexed, {total} chunks)")
        return
    if already:
        # Delete rather than upsert: the new extraction may produce a different
        # number of chunks, and upsert keys on `{doc_id}-{i}`, so a shorter
        # rebuild would leave the tail of the old one behind — still embedded
        # from the broken text, still retrievable.
        sb = runtime.get_supabase()
        sb.table(runtime.VECTOR_TABLE).delete().eq(
            "namespace", runtime.INTERNAL_NAMESPACE
        ).eq("doc_id", doc_id).execute()
        print(f"[wipe] {path.name} (doc_id={doc_id}, removed {total} chunks)")

    text = knowledge_store.read_pdf(pdf_bytes)
    if not text.strip():
        print(f"[warn] {path.name}: no extractable text, skipping")
        return
    chunks = knowledge_store.chunk_text(text)
    total = knowledge_store.upsert_doc(
        doc_id, chunks,
        namespace=runtime.INTERNAL_NAMESPACE,
        extra_metadata={"source_file": path.name, "source_folder": path.parent.name},
    )
    print(f"[ok] {path.name} -> doc_id={doc_id}, {total} chunks")


def main() -> None:
    if not runtime.get_supabase():
        print("Supabase not configured (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Aborting.")
        sys.exit(1)
    if not runtime.oai:
        print("OpenAI not configured (check OPENAI_API_KEY). Aborting.")
        sys.exit(1)

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("folders", nargs="*", help="defaults to <repo>/internelDatabase")
    ap.add_argument("--reingest", action="store_true",
                    help="delete and rebuild docs that are already indexed")
    parsed = ap.parse_args()

    folders = [Path(a).resolve() for a in parsed.folders] if parsed.folders else [DEFAULT_SOURCE_DIR]
    for f in folders:
        if not f.is_dir():
            print(f"[error] not a directory: {f}")
            sys.exit(1)

    pdfs = list(_iter_pdfs(folders))
    if not pdfs:
        print(f"No PDFs found under {[str(f) for f in folders]}")
        return

    print(f"Found {len(pdfs)} PDF(s) under {[str(f) for f in folders]}. "
          f"Namespace: {runtime.INTERNAL_NAMESPACE}"
          + ("  [REINGEST: existing chunks will be deleted]" if parsed.reingest else ""))
    for path in pdfs:
        ingest_file(path, reingest=parsed.reingest)


if __name__ == "__main__":
    main()
