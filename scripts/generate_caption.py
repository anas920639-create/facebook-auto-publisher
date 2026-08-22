#!/usr/bin/env python3
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import torch
from transformers import AutoModelForImageTextToText, AutoProcessor

MODEL_ID = os.environ.get(
    "CAPTION_MODEL",
    "HuggingFaceTB/SmolVLM2-500M-Video-Instruct",
)

PROMPT = """These five images are chronological frames from the SAME short social-media video.

Understand the main human action and the emotional turn across the sequence, then write ONE English Facebook Reel caption/title.

Rules:
- Output ONLY the title. No explanation, no quotes, no label such as "Title:".
- 4 to 9 English words.
- Natural American English.
- Create curiosity and emotion without spoiling the final payoff.
- Do not invent anything that is not supported by the frames.
- Do not identify or guess real people's identities.
- No hashtags.
- At most one emoji, and only when it genuinely fits.
- Avoid generic descriptions such as "Man Helps Woman".
- Prefer the style of these examples, but do NOT copy an example unless it truly fits:
  He Didn't Hesitate to Help ❤️
  He Never Expected This Kindness
  She Stopped for the Right Reason ❤️
  The Baby Knew Before She Did ❤️
"""

def run(cmd):
    return subprocess.run(
        cmd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout.strip()

def video_duration(video_path: str) -> float:
    out = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ])
    duration = float(out)
    if duration <= 0:
        raise RuntimeError("Video duration is invalid.")
    return duration

def extract_frames(video_path: str, out_dir: Path):
    duration = video_duration(video_path)
    fractions = (0.08, 0.28, 0.50, 0.72, 0.92)
    frames = []

    for idx, fraction in enumerate(fractions, start=1):
        t = max(0.0, min(duration - 0.05, duration * fraction))
        frame = out_dir / f"frame-{idx}.jpg"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{t:.3f}",
            "-i", video_path,
            "-frames:v", "1",
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease,"
            "pad=512:512:(ow-iw)/2:(oh-ih)/2",
            "-q:v", "2",
            "-y", str(frame),
        ], check=True)

        if not frame.exists() or frame.stat().st_size == 0:
            raise RuntimeError(f"Could not extract frame {idx}.")
        frames.append(frame)

    return frames

def clean_title(text: str) -> str:
    text = text.strip()

    # Keep the first meaningful line only.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("The caption model returned an empty response.")
    text = lines[0]

    text = re.sub(r"^(title|caption)\s*:\s*", "", text, flags=re.I)
    text = text.strip("`\"'“” ")
    text = re.sub(r"\s+", " ", text)
    text = " ".join(word for word in text.split() if not word.startswith("#")).strip()

    # Count English words; punctuation and an optional emoji do not count.
    words = re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)?", text)
    if not 4 <= len(words) <= 9:
        raise RuntimeError(
            f"Generated caption failed the 4–9 word quality rule ({len(words)} words)."
        )

    if len(text) > 90:
        raise RuntimeError("Generated caption is unexpectedly long.")

    return text

def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: generate_caption.py <video-path>")

    video_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(video_path):
        raise SystemExit("Video file does not exist.")

    print("Extracting representative frames...", file=sys.stderr)
    with tempfile.TemporaryDirectory(prefix="caption-frames-") as tmp:
        frames = extract_frames(video_path, Path(tmp))

        print(f"Loading caption model: {MODEL_ID}", file=sys.stderr)
        processor = AutoProcessor.from_pretrained(MODEL_ID)
        model = AutoModelForImageTextToText.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.float32,
            low_cpu_mem_usage=True,
        )
        model.eval()

        content = [{"type": "image", "path": str(frame)} for frame in frames]
        content.append({"type": "text", "text": PROMPT})
        messages = [{"role": "user", "content": content}]

        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )

        input_len = inputs["input_ids"].shape[-1]

        print("Generating caption...", file=sys.stderr)
        with torch.no_grad():
            generated = model.generate(
                **inputs,
                do_sample=False,
                max_new_tokens=32,
            )

        answer = processor.batch_decode(
            generated[:, input_len:],
            skip_special_tokens=True,
        )[0]

        title = clean_title(answer)
        # stdout intentionally contains ONLY the final title for publisher.js.
        print(title)

if __name__ == "__main__":
    main()
