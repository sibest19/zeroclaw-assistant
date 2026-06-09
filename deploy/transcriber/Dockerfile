# Local ASR microservice: parakeet-tdt-0.6b-v3 via NVIDIA NeMo (CPU).
# Multilingual (incl. Italian). Exposes POST /transcribe (raw audio bytes -> text).
FROM python:3.11-slim

# ffmpeg: decode WhatsApp voice notes (OPUS/OGG) -> wav. libsndfile1: NeMo audio I/O.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch first, so NeMo doesn't pull multi-GB CUDA wheels.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Model weights cache on a mounted volume (downloaded once, ~2.4GB).
ENV HF_HOME=/models
ENV MODEL=nvidia/parakeet-tdt-0.6b-v3
ENV OMP_NUM_THREADS=4

EXPOSE 8770
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8770"]
