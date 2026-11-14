import sys, math
sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\onetake\scripts")
from sfx_palette import Score, air, glass, wood, sub, bubble, wobble, pan_of

B = 60.0 / 122.0
def Q(sec): return round(sec / B) * B

s = Score(dur=124.0, T60=0.95)

# 0 · cold open — the room comes up
s.place(air(1.8, 160, 1200, 1.6, 0.35), 0.02, gain=0.42, send=0.55)
s.place(sub(46, 1.4), 0.10, gain=0.22, send=0.4)

# 1 · sixteen plugins land in a grid (one knock each, panned to its column)
CHIP_X = [358 + c * 312 + 134 for c in range(4)]
for i in range(16):
    t = Q(5.35) + i * 0.105
    col = i % 4
    s.place(wood(215 + (i % 4) * 45, 0.10), t, gain=0.17, pan=pan_of(CHIP_X[col]), send=0.18)

# 2 · grid collapses, the log appears
s.place(air(0.55, 1100, 260, 1.2, 0.35), Q(12.5), gain=0.30, send=0.35)
for k in range(10):
    s.place(wood(330, 0.045), Q(14.3) + k * 0.11, gain=0.055, pan=0.25, send=0.10)
for k in range(12):
    s.place(wood(310, 0.04), Q(17.1) + k * 0.12, gain=0.05, pan=0.35, send=0.10)
# the skipped row lands, then the dry verdict
s.place(sub(72, 0.5), Q(18.7), gain=0.30, send=0.3)
s.place(glass(494, 0.8), Q(18.75), gain=0.10, send=0.4)
s.place(air(0.5, 300, 900, 1.4, 0.4), Q(21.4), gain=0.22, send=0.35)

# 3 · title
s.place(sub(56, 1.3), Q(24.9), gain=0.42, send=0.35)
s.place(glass(523.25, 2.0, 0.6), Q(24.95), gain=0.16, send=0.6)
s.place(glass(783.99, 1.6, 0.5), Q(24.98), gain=0.08, send=0.6)
for j in range(7):
    s.place(wood(300, 0.05), Q(25.2) + j * 0.075, gain=0.05, pan=-0.2 + j * 0.06, send=0.1)
s.place(glass(392.0, 1.6, 0.5), Q(29.6), gain=0.11, send=0.5)
s.place(air(0.6, 350, 1600, 1.5, 0.45), Q(31.6), gain=0.18, send=0.4)

# 4 · the real page, three annotations
s.place(air(0.9, 280, 4200, 1.5, 0.45), Q(34.4), gain=0.48, send=0.45)
s.place(wood(140, 0.16), Q(34.45), gain=0.20, send=0.2)
for i, (t, f, x) in enumerate(((Q(38.4), 659.25, 1302), (Q(41.4), 783.99, 1302), (Q(44.5), 523.25, 1302))):
    s.place(glass(f, 0.9, 0.6), t, gain=0.11, pan=pan_of(x), send=0.5)
    s.place(wood(260, 0.06), t, gain=0.07, pan=pan_of(x), send=0.15)

# 5 · 0.30.1 · struck out · 0.26.1 lands
s.place(sub(58, 1.3), Q(53.0), gain=0.48, send=0.4)
s.place(air(0.6, 1800, 320, 1.3, 0.4), Q(53.05), gain=0.28, send=0.35)
s.place(air(0.40, 5200, 420, 1.1, 0.5), Q(57.0), gain=0.42, send=0.3)
s.place(wood(92, 0.18), Q(57.0), gain=0.28, send=0.2)
s.place(glass(880.0, 1.5, 0.7), Q(61.0), gain=0.20, send=0.55)
s.place(sub(70, 0.9), Q(61.02), gain=0.28, send=0.3)
s.place(wood(168, 0.12), Q(63.6), gain=0.22, send=0.2)
s.place(wood(120, 0.10), Q(65.0), gain=0.22, send=0.2)
s.place(glass(587.33, 1.0, 0.5), Q(67.6), gain=0.09, send=0.5)

# 6 · four sources
for k in range(4):
    s.place(bubble(470 + k * 85), Q(70.2) + k * 0.20, gain=0.20, pan=-0.45 + k * 0.3, send=0.3)
for k in range(4):
    s.place(wood(232, 0.08), Q(71.6) + k * 1.35, gain=0.16, send=0.15)
    s.place(glass(1046.5, 0.7, 0.5), Q(71.6) + k * 1.35, gain=0.07, send=0.5)

# 7 · the rollback card
s.place(sub(52, 1.1), Q(76.2), gain=0.42, send=0.4)
s.place(air(0.7, 1400, 240, 1.2, 0.4), Q(76.25), gain=0.24, send=0.35)
s.place(wood(104, 0.20), Q(78.2), gain=0.28, send=0.2)

# 8 · toast → dialog
s.place(air(0.5, 420, 2600, 1.4, 0.4), Q(84.2), gain=0.26, send=0.35)
s.place(bubble(620), Q(85.0), gain=0.26, pan=0.35, send=0.3)
s.place(glass(784.0, 0.9, 0.6), Q(85.02), gain=0.10, send=0.5)
s.place(sub(60, 0.9), Q(87.6), gain=0.34, send=0.35)
s.place(air(0.6, 600, 3000, 1.4, 0.45), Q(87.65), gain=0.24, send=0.4)

# 9 · three principles, one note each
for k, f in enumerate((523.25, 659.25, 783.99)):
    s.place(glass(f, 1.6, 0.55), Q(96.4) + k * 1.9, gain=0.13, send=0.55)

# 10 · closing line, end card
s.place(glass(392.0, 2.4, 0.5), Q(106.6), gain=0.15, send=0.6)
s.place(sub(58, 1.2), Q(106.62), gain=0.28, send=0.3)
s.place(air(1.6, 200, 2200, 1.8, 0.4), Q(113.8), gain=0.28, send=0.5)
s.place(sub(48, 1.8), Q(113.85), gain=0.30, send=0.4)
s.place(air(2.4, 900, 140, 1.6, 0.5), Q(120.6), gain=0.22, send=0.5)

s.write(r"E:\project\dsh-plugin-update-manager\promo\sfx.wav", peak_db=-9.0)
