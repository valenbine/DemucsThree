#!/usr/bin/env python3
import json
import sys

import librosa
import numpy as np

try:
    import aubio
except ImportError:
    aubio = None

try:
    import essentia.standard as es
except ImportError:
    es = None


NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def main():
    if len(sys.argv) < 2:
        emit_error("missing_audio_path", "缺少音频文件路径。")
        return 2

    try:
        result = analyze(sys.argv[1])
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        emit_error("librosa_failed", str(error))
        return 1


def analyze(file_path):
    y, sr = librosa.load(file_path, sr=22050, mono=True)
    if y.size == 0:
        raise ValueError("音频为空。")

    duration = float(librosa.get_duration(y=y, sr=sr))
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, trim=False)
    tempo = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 0.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key = estimate_key(chroma)
    key_candidates = [{
        "source": "librosa-ks-profile",
        "key": key["key"],
        "confidence": key["confidence"],
    }] if key["key"] else []
    librosa_candidate = build_bpm_candidate("librosa", tempo, beat_times, 0.55)
    aubio_candidate = analyze_with_aubio(file_path)
    librosa_meter = estimate_time_signature_from_beats(
        y,
        sr,
        librosa.frames_to_time(beat_frames, sr=sr),
        "librosa",
        "拍号由 librosa beat strength 周期启发式估算，准确度低于专门的 meter detection 模型。",
    )
    essentia_meter = estimate_time_signature_with_essentia(file_path, y, sr)
    bpm_candidates = [candidate for candidate in [
        librosa_candidate,
        essentia_meter.get("bpmCandidate"),
        aubio_candidate,
    ] if candidate]
    fused_bpm = fuse_bpm_candidates(bpm_candidates)
    beat_choice = choose_beat_sequence(essentia_meter, librosa_meter, aubio_candidate)
    meter = estimate_time_signature_from_beats(
        y,
        sr,
        beat_choice["beatTimes"],
        beat_choice["source"],
        f"拍号由融合选择的 {beat_choice['label']} beat 序列和重音周期启发式估算。",
        beat_choice["confidence"],
    ) if len(beat_choice["beatTimes"]) else (essentia_meter if essentia_meter["timeSignature"] else librosa_meter)

    return {
        "source": "local-audio-feature-fusion",
        "duration": round(duration, 3),
        "bpm": fused_bpm["bpm"],
        "bpmConfidence": fused_bpm["confidence"],
        "bpmSource": fused_bpm["source"],
        "bpmCandidates": bpm_candidates,
        "key": key["key"],
        "keyConfidence": key["confidence"],
        "keyCandidates": key_candidates,
        "timeSignature": meter["timeSignature"],
        "timeSignatureConfidence": meter["confidence"],
        "timeSignatureSource": meter["source"],
        "beatTimes": round_times(beat_choice["beatTimes"]),
        "beatSource": beat_choice["source"],
        "beatConfidence": round(float(beat_choice["confidence"]), 2),
        "beatCount": int(len(beat_choice["beatTimes"])),
        "downbeatTimes": meter.get("downbeatTimes", []),
        "barLines": meter.get("barLines", []),
        "essentiaBeatCount": meter.get("beatCount"),
        "essentiaBeatConfidence": meter.get("beatConfidence"),
        "aubioBeatCount": aubio_candidate.get("beatCount") if aubio_candidate else None,
        "notes": meter["notes"],
    }


def build_bpm_candidate(source, bpm, beat_times, confidence):
    bpm = float(bpm or 0)
    beat_times = np.asarray(beat_times, dtype=float)
    if bpm <= 0 and len(beat_times) > 1:
        intervals = np.diff(beat_times)
        intervals = intervals[intervals > 0]
        bpm = float(60.0 / np.median(intervals)) if len(intervals) else 0
    if bpm <= 0:
        return None
    return {
        "source": source,
        "bpm": round(bpm, 1),
        "confidence": round(float(np.clip(confidence, 0, 1)), 2),
        "beatCount": int(len(beat_times)),
        "beatTimes": round_times(beat_times),
    }


def analyze_with_aubio(file_path):
    if aubio is None:
        return None

    samplerate = 44100
    win_s = 1024
    hop_s = 512
    try:
        source = aubio.source(file_path, samplerate, hop_s)
        samplerate = source.samplerate
        tempo_detector = aubio.tempo("specdiff", win_s, hop_s, samplerate)
        beat_times = []
        while True:
            samples, read = source()
            if tempo_detector(samples):
                beat_times.append(float(tempo_detector.get_last_s()))
            if read < hop_s:
                break
        if len(beat_times) < 2:
            return None
        intervals = np.diff(np.asarray(beat_times, dtype=float))
        intervals = intervals[intervals > 0]
        bpm = float(60.0 / np.median(intervals)) if len(intervals) else 0
        interval_stability = 1.0 - min(float(np.std(intervals)) / (float(np.mean(intervals)) + 1e-6), 1.0)
        return build_bpm_candidate("aubio", bpm, beat_times, interval_stability * 0.75)
    except Exception:
        return None


def fuse_bpm_candidates(candidates):
    normalized = []
    for candidate in candidates:
        bpm = float(candidate.get("bpm") or 0)
        if bpm <= 0:
            continue
        while bpm >= 180:
            bpm /= 2
        while bpm < 70:
            bpm *= 2
        normalized.append((bpm, candidate))

    if not normalized:
        return {"bpm": None, "confidence": 0, "source": "none"}

    clusters = []
    for bpm, candidate in normalized:
        for cluster in clusters:
            if abs(cluster["center"] - bpm) <= 2:
                cluster["items"].append((bpm, candidate))
                weights = [max(0.1, item[1].get("confidence", 0)) for item in cluster["items"]]
                cluster["center"] = float(np.average([item[0] for item in cluster["items"]], weights=weights))
                break
        else:
            clusters.append({"center": bpm, "items": [(bpm, candidate)]})

    clusters.sort(key=lambda cluster: (len(cluster["items"]), sum(item[1].get("confidence", 0) for item in cluster["items"])), reverse=True)
    best = clusters[0]
    weights = [max(0.1, item[1].get("confidence", 0)) for item in best["items"]]
    bpm = float(np.average([item[0] for item in best["items"]], weights=weights))
    agreement = len(best["items"]) / max(1, len(normalized))
    source_confidence = float(np.average([item[1].get("confidence", 0) for item in best["items"]], weights=weights))
    return {
        "bpm": round(bpm, 1),
        "confidence": round(float(np.clip(source_confidence * 0.65 + agreement * 0.35, 0, 1)), 2),
        "source": "+".join(item[1]["source"] for item in best["items"]),
    }


def choose_beat_sequence(essentia_meter, librosa_meter, aubio_candidate):
    candidates = []
    if essentia_meter.get("beatTimes"):
        candidates.append({
            "source": "essentia-rhythmextractor2013",
            "label": "Essentia",
            "confidence": float(np.clip(essentia_meter.get("beatConfidence") or 0, 0, 1)),
            "beatTimes": np.asarray(essentia_meter["beatTimes"], dtype=float),
        })
    if librosa_meter.get("beatTimes"):
        candidates.append({
            "source": "librosa",
            "label": "librosa",
            "confidence": 0.55,
            "beatTimes": np.asarray(librosa_meter["beatTimes"], dtype=float),
        })
    if aubio_candidate and aubio_candidate.get("beatTimes"):
        candidates.append({
            "source": "aubio",
            "label": "Aubio",
            "confidence": aubio_candidate.get("confidence") or 0,
            "beatTimes": np.asarray(aubio_candidate["beatTimes"], dtype=float),
        })
    if not candidates:
        return {"source": "none", "label": "无", "confidence": 0, "beatTimes": np.asarray([], dtype=float)}
    candidates.sort(key=lambda item: (item["confidence"], len(item["beatTimes"])), reverse=True)
    return candidates[0]


def estimate_key(chroma):
    chroma_vector = np.maximum(np.mean(chroma, axis=1), 0)
    if not np.any(chroma_vector):
        return {"key": None, "confidence": 0}

    chroma_vector = zscore(chroma_vector)
    major_profile = zscore(MAJOR_PROFILE)
    minor_profile = zscore(MINOR_PROFILE)
    scores = []

    for root in range(12):
        scores.append((correlation(chroma_vector, np.roll(major_profile, root)), root, "major"))
        scores.append((correlation(chroma_vector, np.roll(minor_profile, root)), root, "minor"))

    scores.sort(reverse=True, key=lambda item: item[0])
    best, root, mode = scores[0]
    second = scores[1][0] if len(scores) > 1 else 0
    confidence = float(np.clip((best - second + 1) / 2, 0, 1))

    return {
        "key": f"{NOTE_NAMES[root]} {mode}",
        "confidence": round(confidence, 2),
    }


def estimate_time_signature_with_essentia(file_path, y, sr):
    if es is None:
        return {
            "timeSignature": None,
            "confidence": 0,
            "source": "librosa-fallback",
            "notes": "Essentia 未安装，已回退到 librosa 拍号估算。",
        }

    try:
        audio = es.MonoLoader(filename=file_path, sampleRate=44100)()
        rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
        bpm, beats, beat_confidence, _, beat_intervals = rhythm_extractor(audio)
        meter = estimate_time_signature_from_beats(
            y,
            sr,
            np.asarray(beats, dtype=float),
            "essentia-rhythmextractor2013",
            "拍号由 Essentia RhythmExtractor2013 beat 序列和重音周期启发式估算。",
            float(beat_confidence),
        )
        meter["essentiaBpm"] = round(float(bpm), 1) if float(bpm) > 0 else None
        meter["bpmCandidate"] = build_bpm_candidate("essentia", bpm, beats, float(beat_confidence))
        meter["beatTimes"] = round_times(beats)
        meter["beatIntervals"] = int(len(beat_intervals))
        return meter
    except Exception as error:
        return {
            "timeSignature": None,
            "confidence": 0,
            "source": "librosa-fallback",
            "notes": f"Essentia 拍号分析失败，已回退到 librosa：{error}",
        }


def estimate_time_signature_from_beats(y, sr, beat_times, source, notes, beat_confidence=None):
    beat_times = np.asarray(beat_times, dtype=float)
    if len(beat_times) < 8:
        return {
            "timeSignature": None,
            "confidence": 0,
            "source": source,
            "notes": "节拍数量不足，无法估算拍号。",
        }

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    beat_frames = librosa.time_to_frames(beat_times, sr=sr)
    beat_strength = np.array([
        float(np.max(onset_env[max(0, frame - 2): min(len(onset_env), frame + 3)]))
        for frame in np.clip(beat_frames, 0, len(onset_env) - 1)
    ])
    if float(np.max(beat_strength)) <= 1e-6:
        return {
            "timeSignature": None,
            "confidence": 0,
            "source": source,
            "notes": "节拍附近没有检测到足够重音，无法估算拍号。",
        }
    candidates = [3, 4, 6]
    scored = []

    for beats_per_bar in candidates:
        best_candidate_score = None
        best_candidate_offset = 0
        for offset in range(beats_per_bar):
            shifted = beat_strength[offset:]
            usable = (len(shifted) // beats_per_bar) * beats_per_bar
            if usable < beats_per_bar * 2:
                continue
            bars = shifted[:usable].reshape(-1, beats_per_bar)
            phase_strength = np.mean(bars, axis=0)
            downbeat = float(phase_strength[0])
            other_beats = float(np.mean(phase_strength[1:])) if beats_per_bar > 1 else 0
            phase_variation = float(np.std(phase_strength))
            contrast = (downbeat - other_beats) / (float(np.std(beat_strength)) + 1e-6)
            score = contrast + phase_variation / (float(np.mean(np.abs(phase_strength))) + 0.1)
            if best_candidate_score is None or score > best_candidate_score:
                best_candidate_score = score
                best_candidate_offset = offset
        if best_candidate_score is not None:
            if beats_per_bar == 6:
                best_candidate_score *= 0.88
            scored.append((best_candidate_score, beats_per_bar, best_candidate_offset))

    if not scored:
        return {
            "timeSignature": None,
            "confidence": 0,
            "source": source,
            "notes": "无法从 beat strength 中估算拍号。",
        }

    scored.sort(reverse=True)
    best_score, best, best_offset = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else 0
    confidence = float(np.clip((best_score - second_score + 0.1) / (abs(best_score) + 0.1), 0, 0.75))
    if beat_confidence is not None:
        confidence = float(np.clip(confidence * 0.7 + np.clip(beat_confidence, 0, 1) * 0.3, 0, 0.9))
    signature = "6/8" if best == 6 else f"{best}/4"
    downbeats = beat_times[best_offset::best]

    return {
        "timeSignature": signature,
        "confidence": round(confidence, 2),
        "source": source,
        "beatCount": int(len(beat_times)),
        "beatTimes": round_times(beat_times),
        "downbeatTimes": round_times(downbeats),
        "barLines": round_times(downbeats),
        "beatConfidence": round(float(np.clip(beat_confidence, 0, 1)), 2) if beat_confidence is not None else None,
        "notes": notes,
    }


def round_times(values):
    return [round(float(value), 3) for value in np.asarray(values, dtype=float).tolist()]


def zscore(values):
    std = float(np.std(values))
    if std == 0:
        return values - np.mean(values)
    return (values - np.mean(values)) / std


def correlation(a, b):
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator == 0:
        return 0.0
    return float(np.dot(a, b) / denominator)


def emit_error(code, message):
    print(json.dumps({"error": code, "message": message}, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
