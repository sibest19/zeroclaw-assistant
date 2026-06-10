"""Local ASR service — parakeet-tdt-0.6b-v3 (NeMo, CPU). Two entry points:
- POST /transcribe        raw audio bytes  -> {"text": ...}  (used by comms/WhatsApp)
- POST /v1/transcribe     multipart 'file' -> {"text": ...}  (faster-whisper-compatible,
                          used by ZeroClaw's local_whisper provider for Telegram voice)
Both accept any ffmpeg-decodable format (OPUS/OGG/…)."""
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, UploadFile, File

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


def _transcribe_bytes(raw: bytes) -> str:
    if _asr is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")
    wav = _decode_to_wav(raw)
    try:
        out = _asr.transcribe([wav])
        hyp = out[0]
        text = getattr(hyp, "text", hyp)  # NeMo returns Hypothesis (.text) or str
        return (text or "").strip()
    finally:
        if os.path.exists(wav):
            os.unlink(wav)


@app.post("/transcribe")
async def transcribe(request: Request):
    """Raw audio bytes in the request body."""
    return {"text": _transcribe_bytes(await request.body())}


@app.post("/v1/transcribe")
async def transcribe_whisper(file: UploadFile = File(...)):
    """faster-whisper-compatible: multipart 'file'. Bearer auth (if any) is ignored —
    the service is only reachable on the private compose network."""
    return {"text": _transcribe_bytes(await file.read())}
