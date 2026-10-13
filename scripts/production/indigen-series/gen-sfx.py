"""Synthesises the small sound-effect set (no samples, no licences): whoosh, tick, pop, lock, chime, fill, pulse."""
import wave, os, sys
import numpy as np

SR = 44100
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)

def t_(d): return np.linspace(0, d, int(SR * d), endpoint=False)
def env_ad(n, a, d_pow=3.0):
    e = np.ones(n); na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    tail = np.linspace(1, 0, n - na) ** d_pow; e[na:] = tail; return e
def lowpass(x, k):
    # simple one-pole filter with per-sample coefficient array or scalar
    y = np.zeros_like(x); a = np.broadcast_to(k, x.shape)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc); y[i] = acc
    return y
def norm(x, peak=0.7):
    m = np.max(np.abs(x)) or 1; return x / m * peak
def save(name, x):
    x = np.clip(x, -1, 1); pcm = (x * 32767).astype('<i2')
    with wave.open(os.path.join(out, name + '.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

# whoosh: noise whose cutoff sweeps up then down
d = 0.6; t = t_(d); n = rng.standard_normal(len(t))
k = 0.02 + 0.5 * np.sin(np.pi * t / d) ** 2
w = lowpass(n, k) * np.sin(np.pi * t / d) ** 1.5
save('whoosh', norm(w, 0.6))
# tick: tiny click
d = 0.14; t = t_(d)
x = np.sin(2 * np.pi * 2200 * t) * np.exp(-t * 60) + 0.4 * rng.standard_normal(len(t)) * np.exp(-t * 180)
save('tick', norm(x, 0.55))
# pop: soft bubble pop
d = 0.22; t = t_(d); f = 700 * np.exp(-t * 9) + 250
x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 18)
save('pop', norm(x, 0.55))
# lock: low thud + click
d = 0.35; t = t_(d)
x = np.sin(2 * np.pi * 110 * t) * np.exp(-t * 14) + 0.6 * np.sin(2 * np.pi * 1700 * t) * np.exp(-t * 90) + 0.25 * rng.standard_normal(len(t)) * np.exp(-t * 120)
save('lock', norm(x, 0.65))
# chime: two soft bell notes
d = 1.6; t = t_(d); x = np.zeros_like(t)
for start, f0 in [(0.0, 880.0), (0.16, 1318.5)]:
    tt = np.clip(t - start, 0, None); m = (t >= start)
    for p, a in [(1, 1.0), (2.01, 0.35), (3.2, 0.18), (4.1, 0.08)]:
        x += m * a * np.sin(2 * np.pi * f0 * p * tt) * np.exp(-tt * (3.2 + p))
save('chime', norm(x, 0.5))
# fill: liquid rising: rising tone + bubbling noise
d = 2.0; t = t_(d); f = 380 + 520 * (t / d) ** 1.5
base = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.25
bub = lowpass(rng.standard_normal(len(t)), 0.08) * (0.5 + 0.5 * np.sin(2 * np.pi * (9 + 8 * t / d) * t) ** 2)
e = np.minimum(1, t / 0.15) * np.minimum(1, (d - t) / 0.5)
save('fill', norm((base + bub * 0.9) * e, 0.5))
# pulse: whirr then zip along the pipe
d = 1.0; t = t_(d); f = 160 + 420 * (t / d) ** 2
saw = 2 * ((np.cumsum(f) / SR) % 1) - 1
w = lowpass(saw, 0.12) * np.minimum(1, t / 0.08) * np.minimum(1, (d - t) / 0.3)
zip_ = lowpass(rng.standard_normal(len(t)), 0.15 + 0.3 * (t / d)) * 0.25 * np.minimum(1, (d - t) / 0.2)
save('pulse', norm(w + zip_, 0.5))
print('ok')
