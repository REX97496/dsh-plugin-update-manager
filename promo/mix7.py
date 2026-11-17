import json, os, re, subprocess, sys, wave
import numpy as np

PROMO = r"E:\project\dsh-plugin-update-manager\promo"
FF = os.path.join(PROMO, "bin", "ffmpeg.exe")
DRAFT = os.path.join(PROMO, "out", "draft7.mp4")
BED = os.path.join(PROMO, "music", "bed6.wav")
MIX = os.path.join(PROMO, "out", "_mix7.wav")
FINAL = os.path.join(PROMO, "out", "dsh-plugin-update-manager-promo-v7-4k60.mp4")
MUS_GAIN = float(os.environ.get("MUS_GAIN", "0.72"))


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw)


def rms_profile(path):
    w = wave.open(path)
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    w.close()
    mono = x.reshape(-1, 2).mean(axis=1)
    win = int(sr * 1.0)
    n = len(mono) // win
    r = np.array([float(np.sqrt(np.mean(mono[i*win:(i+1)*win] ** 2) + 1e-12)) for i in range(n)])
    return r


run([FF, "-v", "error", "-y", "-i", DRAFT, "-i", BED, "-filter_complex",
     f"[0:a]volume=1.0[sfx];[1:a]volume={MUS_GAIN}[mus];[mus][sfx]amix=inputs=2:duration=first:normalize=0[mix]",
     "-map", "[mix]", "-ac", "2", "-ar", "48000", MIX])

prof = rms_profile(MIX)
db = 20 * np.log10(prof + 1e-9)
print("windows", len(prof), "min %.1f dB  median %.1f dB  max %.1f dB  spread %.1f dB"
      % (db.min(), np.median(db), db.max(), db.max() - db.min()))

meas = run([FF, "-v", "info", "-i", MIX, "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]).stderr
m = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
print("measured", {k: m[k] for k in ("input_i", "input_tp", "input_lra", "input_thresh")})

af = ("loudnorm=I=-16:TP=-1.5:LRA=11:linear=true"
      f":measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
      f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}")

run([FF, "-v", "error", "-y", "-i", DRAFT, "-i", MIX, "-filter_complex", f"[1:a]{af}[aout]",
     "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
     "-movflags", "+faststart", FINAL])

out = rms_profile_run = None
w = wave.open(MIX)
print("mix wav", w.getnframes() / w.getframerate(), "s")
w.close()
print("final", FINAL, os.path.getsize(FINAL))
