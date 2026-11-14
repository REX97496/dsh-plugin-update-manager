import subprocess, wave, numpy as np, os

SR = 48000
PROMO = r"E:\project\dsh-plugin-update-manager\promo"
FF = os.path.join(PROMO, "bin", "ffmpeg.exe")

# decode music to 48k stereo wav
tmp = os.path.join(PROMO, "music", "_music48.wav")
subprocess.run([FF, "-v", "error", "-y", "-i", os.path.join(PROMO, "music", "Voxel Revolution.mp3"),
                "-t", "87", "-ac", "2", "-ar", str(SR), tmp], check=True)
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
for a, b in [(11.2, 17.8), (36.4, 45.0), (64.0, 71.2), (71.2, 78.0), (78.0, 84.6)]:
    g = np.minimum(g, ramp(a, b))

# long fade out, and the very end is silent
fade_out = np.clip((84.2 - t) / 2.6, 0, 1)
g = g * np.clip((t - 0.0) / 1.0, 0, 1) * np.where(t > 84.2, fade_out, 1.0)
g = g * np.clip((124.0 - t) / 0.001, 0, 1)

x = x * g[:, None] * 0.30

out = os.path.join(PROMO, "music", "bed2.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
print("bed2.wav", round(len(x) / SR, 2), "s")
