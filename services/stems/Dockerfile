# AZ Studio stem separation — Cloud Run job running Demucs v4 (htdemucs, hybrid transformer) on CPU.
# Neither Gemini nor Lyria returns stems; this open-source model separates vocals, drums, bass and other.
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# CPU builds of torch; demucs 4.0.1 needs torchaudio < 2.1 (so torch 2.0.x) and NumPy 1.x.
RUN pip install --no-cache-dir torch==2.0.1 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir numpy==1.26.4 demucs==4.0.1 google-cloud-storage==2.18.2

# Model weights are baked into the image: nothing is downloaded when a job runs.
ENV TORCH_HOME=/opt/torch
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
 && chmod -R a+rX /opt/torch

WORKDIR /app
COPY main.py ./
USER nobody
ENV HOME=/tmp
CMD ["python", "main.py"]
