const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const CHORD_QUALITIES = [
  { suffix: "", intervals: [0, 4, 7], weights: [1, 0.9, 0.95] },
  { suffix: "m", intervals: [0, 3, 7], weights: [1, 0.9, 0.95] },
  { suffix: "7", intervals: [0, 4, 7, 10], weights: [1, 0.86, 0.9, 0.74] },
  { suffix: "maj7", intervals: [0, 4, 7, 11], weights: [1, 0.84, 0.9, 0.68] },
  { suffix: "m7", intervals: [0, 3, 7, 10], weights: [1, 0.84, 0.9, 0.72] },
  { suffix: "dim", intervals: [0, 3, 6], weights: [1, 0.86, 0.82] },
  { suffix: "sus4", intervals: [0, 5, 7], weights: [1, 0.78, 0.88] },
  { suffix: "sus2", intervals: [0, 2, 7], weights: [1, 0.76, 0.88] },
];

const CHORD_TEMPLATES = buildChordTemplates();

export async function analyzeChordino(buffer, onProgress = () => {}) {
  const audio = mixToMono(buffer);
  const sampleRate = buffer.sampleRate;
  const frameSize = 4096;
  const hopSize = 2048;
  const minFrequency = 55;
  const maxFrequency = 1760;
  const bins = buildFrequencyBins(sampleRate, frameSize, minFrequency, maxFrequency);
  const frames = [];
  const globalChroma = new Array(12).fill(0);
  const frameCount = Math.max(0, Math.floor((audio.length - frameSize) / hopSize));

  if (!frameCount) {
    throw new Error("音频太短，无法提取稳定的和弦特征。");
  }

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = frameIndex * hopSize;
    const chroma = extractChroma(audio, offset, frameSize, bins);
    const smoothed = smoothChroma(chroma);
    const match = matchChord(smoothed);

    for (let i = 0; i < 12; i += 1) {
      globalChroma[i] += smoothed[i];
    }

    frames.push({
      time: offset / sampleRate,
      chord: match.confidence >= 0.58 ? match.name : "N",
      confidence: match.confidence,
      chroma: smoothed,
    });

    if (frameIndex % 8 === 0) {
      onProgress(15 + Math.round((frameIndex / frameCount) * 70));
      await nextFrame();
    }
  }

  const normalizedGlobalChroma = normalize(globalChroma);
  const timeline = mergeFrames(frames, hopSize / sampleRate, buffer.duration);
  const mainChord = findMainChord(timeline);

  onProgress(100);

  return {
    duration: buffer.duration,
    frameCount,
    mainChord,
    globalChroma: normalizedGlobalChroma,
    timeline,
  };
}

function mixToMono(buffer) {
  const output = new Float32Array(buffer.length);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      output[i] += data[i] / buffer.numberOfChannels;
    }
  }

  return output;
}

function buildFrequencyBins(sampleRate, frameSize, minFrequency, maxFrequency) {
  const bins = [];

  for (let frequency = minFrequency; frequency <= maxFrequency; frequency *= 2 ** (1 / 12)) {
    const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
    const pitchClass = ((midi % 12) + 12) % 12;
    const bin = Math.round((frequency * frameSize) / sampleRate);

    if (bin > 0 && bin < frameSize / 2) {
      bins.push({ bin, pitchClass, frequency });
    }
  }

  return bins;
}

function extractChroma(audio, offset, frameSize, bins) {
  const chroma = new Array(12).fill(0);
  const frame = new Float32Array(frameSize);

  for (let i = 0; i < frameSize; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
    frame[i] = (audio[offset + i] || 0) * window;
  }

  for (const item of bins) {
    const magnitude = goertzelMagnitude(frame, item.bin, frameSize);
    const harmonicWeight = item.frequency < 880 ? 1 : 0.72;
    chroma[item.pitchClass] += Math.log1p(magnitude) * harmonicWeight;
  }

  return normalize(chroma);
}

function goertzelMagnitude(samples, bin, frameSize) {
  const omega = (2 * Math.PI * bin) / frameSize;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let previous2 = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i] + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }

  return Math.sqrt(previous2 * previous2 + previous * previous - coefficient * previous * previous2);
}

function smoothChroma(chroma) {
  const max = Math.max(...chroma);
  if (max <= 0) {
    return chroma;
  }

  return normalize(chroma.map((value) => Math.max(0, value - max * 0.08)));
}

function matchChord(chroma) {
  let best = { name: "N", confidence: 0 };

  for (const template of CHORD_TEMPLATES) {
    const score = cosineSimilarity(chroma, template.vector);
    if (score > best.confidence) {
      best = { name: template.name, confidence: score };
    }
  }

  return best;
}

function buildChordTemplates() {
  const templates = [];

  for (let root = 0; root < 12; root += 1) {
    for (const quality of CHORD_QUALITIES) {
      const vector = new Array(12).fill(0.08);
      quality.intervals.forEach((interval, index) => {
        vector[(root + interval) % 12] = quality.weights[index];
      });

      templates.push({
        name: `${NOTE_NAMES[root]}${quality.suffix}`,
        vector: normalize(vector),
      });
    }
  }

  return templates;
}

function mergeFrames(frames, frameDuration, totalDuration) {
  const smoothed = applyModeFilter(frames.map((frame) => frame.chord));
  const timeline = [];
  let current = smoothed[0];
  let start = frames[0].time;
  let confidenceSum = frames[0].confidence;
  let count = 1;

  for (let i = 1; i < frames.length; i += 1) {
    if (smoothed[i] === current) {
      confidenceSum += frames[i].confidence;
      count += 1;
      continue;
    }

    timeline.push({
      chord: current,
      start,
      end: frames[i].time,
      confidence: confidenceSum / count,
    });

    current = smoothed[i];
    start = frames[i].time;
    confidenceSum = frames[i].confidence;
    count = 1;
  }

  timeline.push({
    chord: current,
    start,
    end: totalDuration || frames.at(-1).time + frameDuration,
    confidence: confidenceSum / count,
  });

  return timeline.filter((item) => item.end - item.start >= Math.min(0.35, totalDuration / 20));
}

function applyModeFilter(chords) {
  return chords.map((chord, index) => {
    const window = chords.slice(Math.max(0, index - 2), Math.min(chords.length, index + 3));
    const counts = new Map();

    for (const item of window) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }

    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] || chord;
  });
}

function findMainChord(timeline) {
  const totals = new Map();

  for (const segment of timeline) {
    if (segment.chord === "N") {
      continue;
    }
    totals.set(segment.chord, (totals.get(segment.chord) || 0) + segment.end - segment.start);
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "N";
}

function normalize(values) {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return values.map(() => 0);
  }
  return values.map((value) => value / magnitude);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  if (!magnitudeA || !magnitudeB) {
    return 0;
  }

  return dot / Math.sqrt(magnitudeA * magnitudeB);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export { NOTE_NAMES };
