"""Writes a 6 s test clip as a PNG sequence + WAV: each second has its own colour and a big
number, and a beep starts every second, so cuts and trims are easy to see and hear."""
import math, struct, sys, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1] if len(sys.argv) > 1 else "samples")
(out / "frames").mkdir(parents=True, exist_ok=True)
W, H, FPS, SECS, SR = 640, 360, 30, 6, 48000
colours = [(200, 40, 40), (230, 140, 20), (200, 190, 30), (40, 160, 60), (30, 110, 200), (130, 60, 180)]
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 180)
    small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
except OSError:
    font = small = ImageFont.load_default()
for f in range(FPS * SECS):
    s = f // FPS
    img = Image.new("RGB", (W, H), colours[s])
    d = ImageDraw.Draw(img)
    d.text((W / 2, H / 2), str(s + 1), fill="white", font=font, anchor="mm")
    x = int((f % FPS) / FPS * (W - 40))
    d.rectangle([x, H - 30, x + 40, H - 10], fill="white")
    d.text((10, 10), f"frame {f:03d}", fill="white", font=small)
    img.save(out / "frames" / f"f{f:03d}.png")
with wave.open(str(out / "tone.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    frames = bytearray()
    for i in range(SR * SECS):
        t = i / SR
        s = int(t)
        amp = 0.4 if (t - s) < 0.15 else 0.08
        frames += struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * (330 + 110 * s) * t)))
    w.writeframes(bytes(frames))
print(out.resolve())
