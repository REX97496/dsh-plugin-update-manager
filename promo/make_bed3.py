import subprocess, wave, numpy as np, os

SR = 48000
PROMO = r"E:\project\dsh-plugin-update-manager\promo"
FF = os.path.join(PROMO, "bin", "ffmpeg.exe")

# decode music to 48k stereo wav
tmp = os.path.join(PROMO, "music", "_music48.wav")
subprocess.run([FF, "-v", "error", "-y", "-i", os.path.join(PROMO, "music", "Laser Groove.mp3"),
                "-t", "84", "-ac", "2", "-ar", str(SR), tmp], check=True)
w = wave.open(tmp)
n = w.getnframes()
x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32).reshape(-1, 2) / 32768
w.close()

t = np.arange(len(x)) / SR

def ramp(mask_t0, mask_t1, r=0.18):
    """gain envelope that is 1 outside [t0,t1], ~0 inside, with smooth cosine ramps."""
    g = np.ones_like(t)
    a = np.clip((t - mask_t0) / r, 0, 1)
    b = np.clip((mask_t1 - t) / r, 0, 1)
    inside = np.minimum(a, b)                      # 0 deep inside, 1 outside
    g = np.minimum(g, 1 - (1 - 0.015) * inside)    # duck to -36 dB
    return g

g = np.ones_like(t)
for a, b in [(0.0, 1.2), (14.6, 20.2), (59.8, 66.4), (65.4, 72.2), (71.2, 78.8), (78.0, 82.0)]:
    g = np.minimum(g, ramp(a, b))

# long fade out, and the very end is silent
fade_out = np.clip((81.6 - t) / 2.0, 0, 1)
g = g * np.clip((t - 0.0) / 1.0, 0, 1) * np.where(t > 84.2, fade_out, 1.0)
g = g * np.clip((82.0 - t) / 0.001, 0, 1)

x = x * g[:, None] * 0.52

out = os.path.join(PROMO, "music", "bed3.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
print("bed3.wav", round(len(x) / SR, 2), "s")
