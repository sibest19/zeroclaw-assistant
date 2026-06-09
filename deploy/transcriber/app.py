"""Local ASR service — parakeet-tdt-0.6b-v3 (NeMo, CPU). POST /transcribe with raw
audio bytes (any ffmpeg-decodable format, e.g. WhatsApp OPUS/OGG) -> {"text": ...}."""
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException

MODEL = os.environ.get("MODEL", "nvidia/parakeet-tdt-0.6b-v3")
_asr = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _asr
    import nemo.collections.asr as nemo_asr
    _asr = nemo_asr.models.ASRModel.from_pretrained(MODEL)
    _asr.eval()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": _asr is not None, "model": MODEL}


def _decode_to_wav(raw: bytes) -> str:
    """ffmpeg-decode arbitrary audio bytes to 16kHz mono wav; return wav path."""
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        f.write(raw)
        src = f.name
    wav = src + ".wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav],
        capture_output=True,
    )
    os.unlink(src)
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=f"ffmpeg decode failed: {proc.stderr[-500:].decode(errors='ignore')}")
    return wav


@app.post("/transcribe")
async def transcribe(request: Request):
    if _asr is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty body")
    wav = _decode_to_wav(raw)
    try:
        out = _asr.transcribe([wav])
        hyp = out[0]
        text = getattr(hyp, "text", hyp)  # NeMo returns Hypothesis (.text) or str
        return {"text": (text or "").strip()}
    finally:
        if os.path.exists(wav):
            os.unlink(wav)
