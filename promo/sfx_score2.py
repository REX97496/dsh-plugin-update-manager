import sys, math, os
sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\onetake\scripts")
from sfx_palette import Score, air, glass, wood, sub, bubble, wobble, pan_of

B = 60.0 / 122.0
def Q(sec): return round(sec / B) * B

DUR = 87.0
s = Score(dur=DUR, T60=0.95)

# 0 · cold open
s.place(air(1.8, 160, 1200, 1.6, 0.35), 0.02, gain=0.42, send=0.55)
s.place(sub(46, 1.4), 0.10, gain=0.22, send=0.4)

# 1 · sixteen plugins land (one knock per chip)
CHIP_X = [240 + c * 370 + 165 for c in range(4)]
for i in range(16):
    t = Q(4.42) + 0.06 + i * 0.085
    col = i % 4
    s.place(wood(200 + (i % 4) * 50, 0.10), t, gain=0.16, pan=pan_of(CHIP_X[col]), send=0.18)
    s.place(sub(90, 0.16), t, gain=0.07, send=0.25)

# 2 · grid collapses, log types
s.place(air(0.55, 1100, 260, 1.2, 0.35), Q(10.9), gain=0.30, send=0.35)
for k in range(14):
    s.place(wood(320 + (k % 3) * 40, 0.045), Q(11.15) + 0.3 + k * 0.13, gain=0.05, pan=0.2 + (k % 3) * 0.08, send=0.12)
for k in range(16):
    s.place(wood(290 + (k % 3) * 45, 0.04), Q(11.15) + 2.5 + k * 0.10, gain=0.045, pan=0.3 + (k % 3) * 0.07, send=0.12)
# the skipped row lands, then the dry verdict
s.place(sub(70, 0.5), Q(15.2), gain=0.30, send=0.3)
s.place(glass(494, 0.8), Q(15.25), gain=0.10, send=0.45)
s.place(air(0.5, 300, 900, 1.4, 0.4), Q(16.3), gain=0.22, send=0.35)

# 3 · the name
s.place(sub(56, 1.3), Q(17.9), gain=0.42, send=0.35)
s.place(glass(523.25, 2.0, 0.6), Q(17.95), gain=0.16, send=0.6)
s.place(glass(783.99, 1.6, 0.5), Q(17.98), gain=0.08, send=0.6)
for j in range(7):
    s.place(wood(300, 0.05), Q(18.2) + j * 0.075, gain=0.05, pan=-0.2 + j * 0.06, send=0.1)
s.place(glass(392.0, 1.6, 0.5), Q(20.3), gain=0.11, send=0.5)
s.place(air(0.6, 350, 1600, 1.5, 0.45), Q(21.5), gain=0.18, send=0.4)

# 4 · the manager is drawn: edges, title, rows, toolbar
s.place(air(0.9, 220, 1500, 1.4, 0.4), Q(23.7), gain=0.26, send=0.45)
s.place(wood(150, 0.09), Q(23.75), gain=0.10, send=0.2)
s.place(wood(170, 0.08), Q(24.2), gain=0.09, send=0.2)
s.place(glass(392, 1.2, 0.5), Q(25.1), gain=0.10, send=0.5)
s.place(sub(64, 0.5), Q(25.1), gain=0.20, send=0.3)
for i in range(5):
    s.place(wood(240 + i * 18, 0.07), Q(26.3) + i * 0.30, gain=0.075, pan=-0.35 + i * 0.18, send=0.16)
s.place(air(0.4, 500, 1400, 1.3, 0.3), Q(28.3), gain=0.16, send=0.35)
s.place(bubble(380, 0.10), Q(28.35), gain=0.08, pan=-0.2, send=0.2)
s.place(bubble(420, 0.10), Q(28.85), gain=0.08, pan=0.05, send=0.2)
s.place(bubble(460, 0.10), Q(29.35), gain=0.08, pan=0.3, send=0.2)

# 5 · a check runs
s.place(wood(180, 0.08), Q(29.5), gain=0.16, send=0.2)
s.place(sub(80, 0.3), Q(29.5), gain=0.10, send=0.25)
s.place(air(1.1, 500, 2400, 1.2, 0.4), Q(29.8), gain=0.10, send=0.3)
for k in range(8):
    s.place(wood(520 + k * 30, 0.035), Q(30.0) + k * 0.28, gain=0.035, pan=-0.2 + k * 0.06, send=0.1)
# results land
s.place(glass(659.25, 0.9, 0.5), Q(32.9), gain=0.13, send=0.5)
s.place(glass(987.77, 0.7, 0.4), Q(32.95), gain=0.07, send=0.5)
s.place(sub(70, 0.4), Q(32.9), gain=0.16, send=0.3)
# one-click button pops
s.place(bubble(620, 0.13), Q(34.4), gain=0.14, pan=0.15, send=0.25)
s.place(glass(880, 0.8, 0.45), Q(34.42), gain=0.08, send=0.45)

# 6 · focus on the compatible button
s.place(air(0.8, 1900, 380, 1.6, 0.45), Q(36.2), gain=0.22, send=0.4)
s.place(sub(52, 0.9), Q(36.3), gain=0.18, send=0.3)
# 0.30.1 appears, then gets struck
s.place(sub(46, 0.7), Q(37.9), gain=0.26, send=0.3)
s.place(air(0.45, 2200, 500, 1.2, 0.3), Q(38.6), gain=0.20, send=0.35)
s.place(glass(392, 1.0, 0.5), Q(39.4), gain=0.12, send=0.5)
s.place(sub(88, 0.35), Q(39.4), gain=0.10, send=0.25)

# 7 · cursor travels, clicks
s.place(air(0.9, 400, 1200, 1.4, 0.5), Q(39.8), gain=0.10, send=0.3)
s.place(wood(220, 0.09), Q(41.4), gain=0.20, send=0.2)
s.place(sub(74, 0.32), Q(41.42), gain=0.16, send=0.3)
s.place(glass(1046.5, 0.9, 0.5), Q(43.4), gain=0.14, send=0.55)
s.place(glass(1318.5, 0.8, 0.4), Q(43.44), gain=0.07, send=0.55)
s.place(sub(70, 0.5), Q(43.4), gain=0.18, send=0.3)
s.place(air(0.7, 1600, 300, 1.4, 0.4), Q(44.4), gain=0.16, send=0.35)

# 8 · four sources
for i in range(4):
    t = Q(45.1) + 0.75 + i * 0.30
    s.place(bubble(300 + i * 90, 0.12), t, gain=0.10, pan=-0.5 + i * 0.33, send=0.22)
    s.place(wood(200 + i * 20, 0.06), t, gain=0.05, pan=-0.5 + i * 0.33, send=0.12)
for i in range(4):
    s.place(glass(523.25 * (1 + i * 0.0595), 1.0, 0.5), Q(45.1) + 2.2 + i * 0.55, gain=0.10, pan=-0.45 + i * 0.3, send=0.45)
s.place(air(0.7, 300, 1400, 1.4, 0.4), Q(45.1) + 1.6, gain=0.12, send=0.3)

# 9 · rollback card
s.place(sub(60, 0.8), Q(50.9), gain=0.32, send=0.3)
s.place(air(0.7, 1000, 260, 1.2, 0.35), Q(50.95), gain=0.22, send=0.35)
s.place(air(0.5, 2400, 600, 1.2, 0.3), Q(52.0), gain=0.16, send=0.3)
s.place(glass(392, 1.2, 0.5), Q(53.2), gain=0.10, send=0.5)

# 10 · toast, then the sheet opens
s.place(air(0.8, 260, 1300, 1.4, 0.4), Q(56.7), gain=0.20, send=0.4)
s.place(bubble(540, 0.14), Q(58.2), gain=0.14, pan=0.55, send=0.3)
s.place(bubble(600, 0.10), Q(58.3), gain=0.08, pan=0.5, send=0.25)
s.place(sub(72, 0.5), Q(59.6), gain=0.20, send=0.3)
s.place(air(0.9, 1400, 320, 1.5, 0.4), Q(59.9), gain=0.18, send=0.4)
s.place(glass(783.99, 1.2, 0.5), Q(60.1), gain=0.09, send=0.5)

# 11 · three principles
for i in range(3):
    s.place(glass(523.25 * (1 + i * 0.1), 1.3, 0.55), Q(64.1) + i * 0.62, gain=0.12, send=0.5)
    s.place(wood(260 + i * 40, 0.06), Q(64.1) + i * 0.62, gain=0.05, pan=-0.4 + i * 0.35, send=0.15)

# 12 · the line
s.place(glass(392, 2.4, 0.6), Q(70.9), gain=0.15, send=0.6)
s.place(glass(587.33, 2.0, 0.5), Q(70.95), gain=0.09, send=0.6)
s.place(sub(58, 1.0), Q(70.9), gain=0.24, send=0.3)

# 13 · end card, then black
s.place(air(1.6, 300, 1600, 1.6, 0.5), Q(78.0), gain=0.20, send=0.5)
s.place(sub(48, 1.6), Q(78.05), gain=0.20, send=0.35)
s.place(glass(659.25, 2.2, 0.5), Q(78.1), gain=0.07, send=0.6)
s.place(air(2.6, 900, 200, 2.0, 1.2), Q(84.0), gain=0.22, send=0.45)

out = os.path.join(r"E:\project\dsh-plugin-update-manager\promo", "sfx2.wav")
s.write(out, peak_db=-9.0)
print("wrote", out, "dur", DUR)
