#!/usr/bin/env python3
"""
Wrapper for demucs that patches torchaudio.load to use ffmpeg before calling demucs.
This works around torchcodec compatibility issues.
"""

import subprocess
import tempfile
import os
import sys
import numpy as np

# Must import and patch before torchaudio is used by demucs
import torchaudio

def load_audio_with_ffmpeg(path):
    """Load audio file using ffmpeg and return (tensor, sample_rate)."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_wav = tmp.name
    
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", path, "-ar", "44100", "-ac", "2", tmp_wav],
            capture_output=True, text=True, timeout=300
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")
        
        # torchaudio might still fail on wav loading with torchcodec, use scipy/numpy as last resort
        try:
            wav, sr = torchaudio.load(tmp_wav)
            return wav, sr
        except Exception:
            # Fallback: use scipy or pure numpy
            from scipy.io import wavfile
            sr, data = wavfile.read(tmp_wav)
            import torch
            if data.ndim == 1:
                data = data.reshape(1, -1)
            else:
                data = data.T
            tensor = torch.from_numpy(data.astype(np.float32) / 32768.0)
            return tensor, sr
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)

def patched_load(filepath, *args, **kwargs):
    try:
        return torchaudio._original_load(filepath, *args, **kwargs)
    except Exception:
        return load_audio_with_ffmpeg(filepath)

torchaudio._original_load = torchaudio.load
torchaudio.load = patched_load

# Now call demucs
from demucs.separate import main
sys.exit(main())
