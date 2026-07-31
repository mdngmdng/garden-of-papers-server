import os
import gc
import threading
from contextlib import asynccontextmanager
from typing import Literal

import torch
from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer


EMBEDDING_MODEL_NAME = os.getenv(
    "QWEN_EMBEDDING_MODEL",
    "Qwen/Qwen3-Embedding-0.6B",
)
RERANKER_MODEL_NAME = os.getenv(
    "QWEN_RERANKER_MODEL",
    "Qwen/Qwen3-Reranker-0.6B",
)
QUERY_INSTRUCTION = os.getenv(
    "QWEN_QUERY_INSTRUCTION",
    (
        "Instruct: Given a sentence that cites an academic paper, retrieve sentences "
        "from that paper that directly support the cited claim.\nQuery: "
    ),
)
RERANK_INSTRUCTION = os.getenv(
    "QWEN_RERANK_INSTRUCTION",
    (
        "Judge whether a sentence from a cited academic paper directly supports "
        "the claim made about that paper in the citing context"
    ),
)
MAX_SEQUENCE_LENGTH = int(os.getenv("QWEN_MAX_SEQUENCE_LENGTH", "512"))
EMBED_BATCH_SIZE = int(os.getenv("QWEN_EMBED_BATCH_SIZE", "8"))
RERANK_BATCH_SIZE = int(os.getenv("QWEN_RERANK_BATCH_SIZE", "4"))
MAX_REQUEST_TEXTS = int(os.getenv("QWEN_MAX_REQUEST_TEXTS", "96"))
WARM_EMBEDDINGS_AFTER_RERANK = os.getenv(
    "QWEN_WARM_EMBEDDINGS_AFTER_RERANK",
    "true",
).lower() in {"1", "true", "yes"}

_embedding_model = None
_reranker_model = None
_model_lock = threading.RLock()
_inference_lock = threading.Lock()


def resolve_device() -> str:
    configured = os.getenv("QWEN_DEVICE", "auto").lower()
    if configured != "auto":
        return configured
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEVICE = resolve_device()
MODEL_DTYPE = torch.float32 if DEVICE == "cpu" else torch.float16


def get_embedding_model() -> SentenceTransformer:
    global _embedding_model, _reranker_model
    if _embedding_model is not None:
        return _embedding_model
    with _model_lock:
        if _embedding_model is None:
            if _reranker_model is not None:
                print("[Qwen] Releasing reranker before loading embeddings", flush=True)
                _reranker_model = None
                gc.collect()
            print(
                f"[Qwen] Loading embedding model {EMBEDDING_MODEL_NAME} on {DEVICE}",
                flush=True,
            )
            model = SentenceTransformer(
                EMBEDDING_MODEL_NAME,
                device=DEVICE,
                model_kwargs={"dtype": MODEL_DTYPE},
                tokenizer_kwargs={"padding_side": "left"},
            )
            model.max_seq_length = MAX_SEQUENCE_LENGTH
            _embedding_model = model
            print("[Qwen] Embedding model ready", flush=True)
    return _embedding_model


def get_reranker_model() -> CrossEncoder:
    global _embedding_model, _reranker_model
    if _reranker_model is not None:
        return _reranker_model
    with _model_lock:
        if _reranker_model is None:
            if _embedding_model is not None:
                print("[Qwen] Releasing embeddings before loading reranker", flush=True)
                _embedding_model = None
                gc.collect()
            print(
                f"[Qwen] Loading reranker model {RERANKER_MODEL_NAME} on {DEVICE}",
                flush=True,
            )
            model = CrossEncoder(
                RERANKER_MODEL_NAME,
                device=DEVICE,
                max_length=MAX_SEQUENCE_LENGTH,
                model_kwargs={"dtype": MODEL_DTYPE},
                prompts={"citation_evidence": RERANK_INSTRUCTION},
                default_prompt_name="citation_evidence",
            )
            _reranker_model = model
            print("[Qwen] Reranker model ready", flush=True)
    return _reranker_model


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)
    kind: Literal["query", "document"] = "document"


class RerankRequest(BaseModel):
    query: str = Field(min_length=1)
    documents: list[str] = Field(min_length=1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    print(
        f"[Qwen] Service started on {DEVICE}; models load lazily on first use",
        flush=True,
    )
    if os.getenv("QWEN_PRELOAD", "false").lower() in {"1", "true", "yes"}:
        get_embedding_model()
        get_reranker_model()
    yield


app = FastAPI(title="Garden of Papers Qwen retrieval", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "embeddingModel": EMBEDDING_MODEL_NAME,
        "rerankerModel": RERANKER_MODEL_NAME,
        "embeddingReady": _embedding_model is not None,
        "rerankerReady": _reranker_model is not None,
    }


def warm_embedding_model():
    with _inference_lock:
        get_embedding_model()


@app.post("/embed")
def embed(request: EmbedRequest):
    if len(request.texts) > MAX_REQUEST_TEXTS:
        raise HTTPException(
            status_code=413,
            detail=f"At most {MAX_REQUEST_TEXTS} texts are allowed per request",
        )
    texts = [text.strip() for text in request.texts]
    if any(not text for text in texts):
        raise HTTPException(status_code=400, detail="Texts must not be empty")

    with _inference_lock:
        model = get_embedding_model()
        prompt = QUERY_INSTRUCTION if request.kind == "query" else None
        vectors = model.encode(
            texts,
            prompt=prompt,
            batch_size=EMBED_BATCH_SIZE,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    return {
        "model": EMBEDDING_MODEL_NAME,
        "dimensions": int(vectors.shape[1]),
        "embeddings": vectors.astype("float32").tolist(),
    }


@app.post("/rerank")
def rerank(request: RerankRequest, background_tasks: BackgroundTasks):
    if len(request.documents) > MAX_REQUEST_TEXTS:
        raise HTTPException(
            status_code=413,
            detail=f"At most {MAX_REQUEST_TEXTS} documents are allowed per request",
        )
    query = request.query.strip()
    documents = [document.strip() for document in request.documents]
    if not query or any(not document for document in documents):
        raise HTTPException(
            status_code=400,
            detail="Query and documents must not be empty",
        )

    with _inference_lock:
        model = get_reranker_model()
        pairs = [(query, document) for document in documents]
        scores = model.predict(
            pairs,
            batch_size=RERANK_BATCH_SIZE,
            activation_fn=torch.nn.Sigmoid(),
            show_progress_bar=False,
        )
    if WARM_EMBEDDINGS_AFTER_RERANK:
        background_tasks.add_task(warm_embedding_model)
    return {
        "model": RERANKER_MODEL_NAME,
        "scores": [float(score) for score in scores],
    }
