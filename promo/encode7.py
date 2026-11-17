import json, os, subprocess

PROMO = r"E:\project\dsh-plugin-update-manager\promo"
FF = os.path.join(PROMO, "bin", "ffmpeg.exe")
DRAFT = os.path.join(PROMO, "out", "draft7.mp4")
MIX = os.path.join(PROMO, "out", "_mix7.wav")
AUD = os.path.join(PROMO, "out", "_audio7.wav")
FINAL = os.path.join(PROMO, "out", "dsh-plugin-update-manager-promo-v7-4k60.mp4")


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


meas = run([FF, "-v", "info", "-i", MIX, "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]).stderr
m = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
af = ("loudnorm=I=-16:TP=-1.5:LRA=11:linear=true"
      f":measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
      f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}")

run([FF, "-v", "error", "-y", "-i", MIX, "-af", af, "-ac", "2", "-ar", "48000", AUD])

run([FF, "-v", "error", "-y", "-i", DRAFT, "-i", AUD,
     "-map", "0:v", "-map", "1:a",
     "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv420p",
     "-x264-params", "keyint=120:min-keyint=60",
     "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", FINAL])

print("final", FINAL, os.path.getsize(FINAL))
