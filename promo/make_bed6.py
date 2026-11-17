import subprocess, wave, numpy as np, os

SR = 48000
PROMO = r"E:\project\dsh-plugin-update-manager\promo"
FF = os.path.join(PROMO, "bin", "ffmpeg.exe")
TRACK = os.path.join(PROMO, "music", "Laser Groove.mp3")
OUT = os.path.join(PROMO, "music", "bed6.wav")
DUR = 82.0

tmp = os.path.join(PROMO, "music", "_music48.wav")
subprocess.run([FF, "-v", "error", "-y", "-i", TRACK, "-t", str(DUR + 0.2),
                "-ac", "2", "-ar", str(SR), tmp], check=True)
w = wave.open(tmp)
x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32).reshape(-1, 2) / 32768
w.close()

t = np.arange(len(x)) / SR

# constant level all the way through: no ducking under any section
g = np.ones_like(t)
# gentle ramp in (0.45 s) and a short de-click fade at the very end
g = g * np.clip(t / 0.45, 0, 1)
g = g * np.clip((DUR - t) / 0.8, 0, 1)

x = x * g[:, None] * 0.62
x = x[: int(DUR * SR)]

with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(np.clip(x * 32767, -32768, 32767).astype(np.int16).tobytes())

print("wrote", OUT, os.path.getsize(OUT))
