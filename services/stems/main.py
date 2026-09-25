"""AZ Studio stem separation (Cloud Run job).

Reads INPUT_PATH from the private media bucket, separates it with Demucs v4 (htdemucs) into vocals,
drums, bass and other, uploads the stems under OUTPUT_PREFIX and writes OUTPUT_PREFIX/manifest.json.
The Cloud Function that launched the job turns the stems into assets when the execution succeeds.
"""

import json
import os
import pathlib
import subprocess
import sys
import time

from google.cloud import storage

BUCKET = os.environ.get("AZS_MEDIA_BUCKET", "az-studio-media-az-learner")
STEMS = ["vocals", "drums", "bass", "other"]


def duration(path: pathlib.Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return round(float(out or 0), 3)


def main() -> None:
    source_path = os.environ["INPUT_PATH"]
    prefix = os.environ["OUTPUT_PREFIX"].rstrip("/")
    started = time.time()
    bucket = storage.Client().bucket(BUCKET)
    work = pathlib.Path("/tmp/work")
    work.mkdir(parents=True, exist_ok=True)

    source = work / ("source" + (pathlib.Path(source_path).suffix or ".bin"))
    bucket.blob(source_path).download_to_filename(str(source))
    wav = work / "input.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", str(wav)], check=True)
    print(f"decoded {duration(wav)} s of audio", flush=True)

    subprocess.run(
        [sys.executable, "-m", "demucs", "-n", "htdemucs", "--mp3", "--mp3-bitrate", "320", "-o", str(work / "out"), str(wav)],
        check=True,
    )
    stem_dir = work / "out" / "htdemucs" / "input"
    stems = []
    for name in STEMS:
        f = stem_dir / f"{name}.mp3"
        if not f.exists():
            raise SystemExit(f"Demucs did not produce the {name} stem")
        dest = f"{prefix}/{name}.mp3"
        blob = bucket.blob(dest)
        blob.cache_control = "private, max-age=31536000"
        blob.upload_from_filename(str(f), content_type="audio/mpeg")
        stems.append({"name": name, "path": dest, "durationSec": duration(f)})
        print(f"uploaded {dest}", flush=True)

    manifest = {"model": "htdemucs", "stems": stems, "seconds": round(time.time() - started, 1)}
    bucket.blob(f"{prefix}/manifest.json").upload_from_string(json.dumps(manifest), content_type="application/json")
    print(json.dumps(manifest), flush=True)


if __name__ == "__main__":
    main()
