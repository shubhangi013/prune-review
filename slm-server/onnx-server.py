"""
onnx-server.py — Minimal FastAPI wrapper around onnxruntime-genai for local
SLM triage. Exposes an OpenAI-compatible /v1/chat/completions surface, so the
Node orchestrator (prune-review core) talks to it exactly the same way it
would talk to OpenAI, Foundry Local, or any other OpenAI-compat endpoint.

Usage:
  pip install fastapi uvicorn onnxruntime-genai            # CPU
  pip install fastapi uvicorn onnxruntime-genai-directml   # Windows GPU
  pip install fastapi uvicorn onnxruntime-genai-cuda       # NVIDIA
  # QNN (NPU) has its own install path per onnxruntime-genai docs.

  python onnx-server.py --model-dir <path-to-phi-3.5-mini-int4> --port 8000

Any local phi-3.5-mini-instruct-onnx (INT4) checkpoint from Hugging Face works;
the sidecar is model-agnostic within onnxruntime-genai's supported set.
"""
from __future__ import annotations
import argparse
import time
import uuid
from typing import Any

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

try:
    import onnxruntime_genai as og  # type: ignore
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "onnxruntime-genai is not installed. Pick the variant for your hardware:\n"
        "  pip install onnxruntime-genai            (CPU)\n"
        "  pip install onnxruntime-genai-directml   (Windows GPU)\n"
        "  pip install onnxruntime-genai-cuda       (NVIDIA CUDA)\n"
    ) from e


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int = 200
    temperature: float = 0.0
    top_p: float = 1.0
    stream: bool = False


def build_app(model_dir: str) -> FastAPI:
    print(f"[onnx-server] loading model from {model_dir} ...")
    t0 = time.time()
    model = og.Model(model_dir)
    tokenizer = og.Tokenizer(model)
    print(f"[onnx-server] model loaded in {time.time() - t0:.1f}s")

    app = FastAPI(title="prune-review ONNX sidecar", version="0.1.0")

    @app.get("/v1/models")
    def list_models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{"id": "phi-3.5-mini-instruct", "object": "model"}],
        }

    @app.post("/v1/chat/completions")
    def chat(req: ChatRequest) -> dict[str, Any]:
        # phi-3.5-mini instruction template.
        prompt_parts: list[str] = []
        for m in req.messages:
            if m.role == "system":
                prompt_parts.append(f"<|system|>\n{m.content}<|end|>\n")
            elif m.role == "user":
                prompt_parts.append(f"<|user|>\n{m.content}<|end|>\n")
            elif m.role == "assistant":
                prompt_parts.append(f"<|assistant|>\n{m.content}<|end|>\n")
        prompt_parts.append("<|assistant|>\n")
        prompt = "".join(prompt_parts)

        input_tokens = tokenizer.encode(prompt)
        prompt_token_count = len(input_tokens)

        params = og.GeneratorParams(model)
        params.set_search_options(
            max_length=prompt_token_count + req.max_tokens,
            temperature=max(req.temperature, 1e-4),
            top_p=req.top_p,
        )
        params.input_ids = input_tokens

        generator = og.Generator(model, params)
        generated: list[int] = []
        while not generator.is_done():
            generator.compute_logits()
            generator.generate_next_token()
            new_tokens = generator.get_next_tokens()
            generated.extend(new_tokens.tolist() if hasattr(new_tokens, "tolist") else list(new_tokens))
            # Stop early on <|end|>.
            if generated and generated[-1] in {tokenizer.encode("<|end|>")[-1]}:
                break

        completion = tokenizer.decode(generated).split("<|end|>")[0].strip()
        completion_token_count = len(generated)

        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": req.model or "phi-3.5-mini-instruct",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": completion},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_token_count,
                "completion_tokens": completion_token_count,
                "total_tokens": prompt_token_count + completion_token_count,
            },
        }

    return app


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", required=True, help="Path to onnxruntime-genai model directory")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()

    app = build_app(args.model_dir)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
