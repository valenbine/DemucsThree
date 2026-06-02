#!/usr/bin/env python3
"""Monkey-patch torchaudio.load to bypass torchcodec and use ffmpeg instead."""

import subprocess
import tempfile
import os
import numpy as np
import torchaudio

def load_audio_with_ffmpeg(path):
    """Load audio file using ffmpeg and return tensor."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_wav = tmp.name
    
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-ar", "44100", "-ac", "2", tmp_wav],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")
        
        # Use torchaudio to load the wav file (should work without torchcodec for wav)
        wav, sr = torchaudio.load(tmp_wav)
        return wav, sr
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)

original_load = torchaudio.load

def patched_load(filepath, *args, **kwargs):
    try:
        return original_load(filepath, *args, **kwargs)
    except Exception:
        return load_audio_with_ffmpeg(filepath)

torchaudio.load = patched_load

print("[Patched] torchaudio.load now uses ffmpeg fallback")
