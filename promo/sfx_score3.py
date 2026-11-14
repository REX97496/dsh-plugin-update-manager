"""v3 sound design — 140 BPM grid, sparse and physical.

Every hit sits on the beat lattice (B = 60/140) so picture events read as
"something happened", not as a soundtrack laid underneath.
"""
import sys
sys.path.insert(0, r"C:\Users\Administrator\.dsh\skills\onetake\scripts")
from sfx_palette import Score, wood, glass, air, sub, bubble

DUR = 82.0
B = 60.0 / 140.0
Q = lambda n: round(n * B, 4)          # n beats after zero
sc = Score(DUR)

# ── 0 · opening ──────────────────────────────────────────────────────
sc.place(air(1.5, 380, 5200), 0.02, -22)
sc.place(sub(62, 1.2), 0.02, -26)
sc.place(wood(180, 0.5), Q(2), -27)

# ── chips: one tick per card, panned by column ───────────────────────
CHIP = Q(3.0) + 0.02
for i in range(16):
    sc.place(wood(190, 0.16), CHIP + i * 0.105, -29, pan=-0.65 + (i % 4) * 0.42)
sc.place(glass(720, 1.2), CHIP + 16 * 0.105 + 0.18, -26)
sc.place(sub(62, 1.0), CHIP + 16 * 0.105 + 0.18, -27)
sc.place(air(1.0, 900, 6000), Q(8.4), -30)

# ── gate / log typing ────────────────────────────────────────────────
LOG = Q(9.0)
for k in range(26):
    sc.place(wood(220, 0.09), LOG + k * 0.062, -37, pan=-0.12)
sc.place(sub(58, 1.4), Q(12.9), -24)
sc.place(glass(300, 1.5), Q(13.4), -25)
sc.place(air(1.1, 600, 3800), Q(14.4), -29)

# ── title ────────────────────────────────────────────────────────────
TITLE = Q(15.2) + 0.04
sc.place(sub(52, 1.8), TITLE, -22)
sc.place(glass(220, 2.2), TITLE, -24)
sc.place(glass(330, 2.4), TITLE + 0.10, -27)
for k in range(6):
    sc.place(wood(240, 0.12), TITLE + 0.18 + k * 0.11, -33)
sc.place(air(1.6, 500, 5200), Q(19.0), -28)

# ── settings dialog · push in · nav move · click ─────────────────────
sc.place(air(1.4, 700, 4600), Q(20.2), -28)
sc.place(wood(200, 0.4), Q(21.6), -32)
sc.place(sub(62, 1.0), Q(22.8), -33)
for k in range(3):
    sc.place(wood(260, 0.10), Q(23.0) + k * 0.22, -38, pan=-0.2 + k * 0.06)
sc.place(wood(150, 0.9), Q(24.4), -25, pan=-0.12)          # nav click
sc.place(glass(520, 1.3), Q(24.6), -28)                    # page swap
sc.place(air(0.9, 420, 2600), Q(24.6), -31)
sc.place(air(1.2, 1200, 4000), Q(26.0), -30)               # pull back

# ── toolbar + rows ───────────────────────────────────────────────────
TOOL = Q(27.8)
for k in range(5):
    sc.place(wood(250, 0.09), TOOL + k * 0.06, -35)
ROW = Q(27.9)
for k in range(9):
    sc.place(wood(300, 0.06), ROW + k * 0.055, -39, pan=-0.3 + (k % 3) * 0.2)
sc.place(wood(170, 0.55), Q(28.8), -26)                    # 立即检查 click
for k in range(7):                                          # scan run-up
    sc.place(glass(700 + k * 90, 0.30), Q(29.1) + k * 0.30, -33, pan=-0.15)
sc.place(glass(880, 1.5), Q(31.8), -24)                     # results land
sc.place(sub(60, 1.1), Q(31.8), -25)
sc.place(glass(1180, 1.0), Q(32.3), -30)
sc.place(sub(55, 1.2), Q(33.0), -22)                        # 一键更新 springs in
sc.place(glass(660, 1.1), Q(33.0), -27)

# ── focus · strike · compatible version · click · done ───────────────
sc.place(air(1.2, 900, 3400), Q(34.4), -30)
sc.place(sub(52, 1.6), Q(36.0), -23)                        # 0.30.1 strike
sc.place(air(1.2, 5200, 380), Q(36.0), -27)
sc.place(glass(990, 1.6), Q(37.4), -23)                     # 0.26.1 lands
sc.place(sub(58, 1.4), Q(37.4), -25)
for k in range(4):
    sc.place(wood(280, 0.08), Q(37.8) + k * 0.16, -40, pan=0.2 + k * 0.05)
sc.place(wood(155, 0.9), Q(39.4), -22, pan=0.1)             # click
sc.place(glass(620, 1.9), Q(41.4), -22)                     # done
sc.place(glass(930, 2.1), Q(41.4) + 0.10, -26)
sc.place(sub(62, 1.3), Q(41.4), -26)

# ── four sources ─────────────────────────────────────────────────────
for k in range(4):
    t = Q(43.2) + k * B
    sc.place(bubble(560 + k * 120, 1.2), t, -29, pan=-0.5 + k * 0.33)
    sc.place(wood(230, 0.14), t + 0.06, -34)
sc.place(air(1.4, 700, 5000), Q(43.2), -30)

# ── rollback card ────────────────────────────────────────────────────
sc.place(sub(58, 1.5), Q(48.2), -24)
sc.place(air(1.2, 4200, 600), Q(48.2), -28)
sc.place(glass(280, 1.0), Q(49.0), -29)

# ── toast + dialog ───────────────────────────────────────────────────
sc.place(air(1.1, 500, 4200), Q(53.2), -29)
sc.place(bubble(760, 1.4), Q(53.4), -26)
sc.place(wood(190, 0.7), Q(54.0), -30)
sc.place(sub(56, 1.6), Q(56.0), -24)
sc.place(air(1.3, 800, 3600), Q(56.0), -29)

# ── three principles ─────────────────────────────────────────────────
for k in range(3):
    t = Q(60.2) + k * 2 * B
    sc.place(glass(440 + k * 110, 2.2), t, -25)
    sc.place(wood(250, 0.12), t, -33)

# ── closing line ─────────────────────────────────────────────────────
sc.place(glass(220, 3.0), Q(66.0), -22)
sc.place(glass(330, 3.2), Q(66.0) + 0.08, -25)
sc.place(sub(52, 1.8), Q(66.0), -25)

# ── end card + fade ──────────────────────────────────────────────────
sc.place(air(2.4, 380, 5200), Q(71.6), -27)
sc.place(sub(50, 2.2), Q(71.6), -24)
sc.place(glass(190, 2.6), Q(72.2), -26)
sc.place(air(4.0, 600, 2400), 78.2, -30)

sc.write(r"E:\project\dsh-plugin-update-manager\promo\sfx3.wav", peak_db=-9.0)
print("events:", len(sc.events), "dur:", DUR)
