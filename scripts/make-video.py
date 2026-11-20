"""Build the demo video from a real screen recording.

Usage: python scripts/make-video.py spec.json out.mp4

spec.json:
{
  "segments": [
    {"card": "intro"},
    {"card": "overview"},
    {"card": "arch"},
    {"card": "section", "title": "Task A", "sub": "Inline edit with per-hunk review"},
    {"src": "rec.mp4", "start": "0:12", "end": "0:40", "speed": 1,
     "caption": "Task A  ·  inline edit", "sub": "select get_debug_flag → Ctrl+Alt+E",
     "mark": "A1"},
    {"card": "outro"}
  ]
}

Footage is never invented: every non-card segment is a slice of the real
recording. "speed" > 1 fast-forwards model waiting time and is shown on screen
as a badge. The script prints where each segment (and each "mark") starts in
the final video, which is what goes into the write-up scorecard.
"""
import json, math, os, subprocess, sys, tempfile, shutil, glob
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
BG = (11, 16, 32)
FG = (236, 240, 248)
DIM = (140, 152, 176)
ACCENT = (255, 159, 67)
ACCENT2 = (94, 196, 255)
FONT_DIR = "C:/Windows/Fonts"


def font(size, bold=False):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def mono(size):
    return ImageFont.truetype(os.path.join(FONT_DIR, "consola.ttf"), size)


def ffbin(name):
    p = shutil.which(name)
    if p:
        return p
    hits = glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""),
        "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "ffmpeg-*", "bin", name + ".exe"))
    if not hits:
        sys.exit(f"{name} not found")
    return hits[0]


FFMPEG, FFPROBE = ffbin("ffmpeg"), ffbin("ffprobe")


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def tsec(s):
    if isinstance(s, (int, float)):
        return float(s)
    parts = [float(p) for p in s.split(":")]
    v = 0.0
    for p in parts:
        v = v * 60 + p
    return v


def fmt(sec):
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"


# ---------------------------------------------------------------- cards
def text_c(d, y, s, f, fill, alpha=1.0, dx=0):
    w = d.textlength(s, font=f)
    col = tuple(int(c * alpha + b * (1 - alpha)) for c, b in zip(fill, BG))
    d.text(((W - w) / 2 + dx, y), s, font=f, fill=col)


def text_l(d, x, y, s, f, fill, alpha=1.0):
    col = tuple(int(c * alpha + b * (1 - alpha)) for c, b in zip(fill, BG))
    d.text((x, y), s, font=f, fill=col)


def backdrop(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # slow drifting grid of dots
    off = (t * 12) % 60
    for gx in range(-60, W + 60, 60):
        for gy in range(-60, H + 60, 60):
            d.point((gx + off, gy + off / 2), fill=(30, 38, 62))
    return img, d


def card_intro(t, dur):
    img, d = backdrop(t)
    a1, a2, a3 = ease(t / 0.8), ease((t - 0.5) / 0.8), ease((t - 1.0) / 0.8)
    out = 1 - ease((t - (dur - 0.5)) / 0.5)
    bar = int(420 * a1)
    d.rectangle(((W - bar) / 2, 350, (W + bar) / 2, 356), fill=ACCENT)
    text_c(d, 390 + 30 * (1 - a1), "Forge Agent", font(120, True), FG, a1 * out)
    text_c(d, 560 + 20 * (1 - a2), "An editor-native coding agent whose loop runs on TrueFoundry TrueForge",
           font(40), DIM, a2 * out)
    text_c(d, 700, "Team StarDust  ·  Techfest IIT Bombay  ·  Forge-a-thon 2026", font(32), ACCENT, a3 * out)
    return img


def card_overview(t, dur):
    img, d = backdrop(t)
    out = 1 - ease((t - (dur - 0.5)) / 0.5)
    a0 = ease(t / 0.6)
    text_c(d, 300, "Three fixed tasks on Flask 3.1.3", font(80, True), FG, a0 * out)
    items = [("A", "Inline edit", "get_debug_flag, per-hunk diff"),
             ("B", "Agent mode", "flask config · 3 files, unprompted"),
             ("C", "Provider failure", "dead endpoint → automatic fallback")]
    for i, (k, name, sub) in enumerate(items):
        a = ease((t - 0.5 - 0.35 * i) / 0.6) * out
        x = 180 + i * 540 + int(40 * (1 - a))
        y = 500
        col = tuple(int(c * a + b * (1 - a)) for c, b in zip((24, 32, 56), BG))
        d.rounded_rectangle((x, y, x + 480, y + 220), 18, fill=col)
        text_l(d, x + 32, y + 24, k, font(72, True), ACCENT, a)
        text_l(d, x + 110, y + 44, name, font(40, True), FG, a)
        text_l(d, x + 32, y + 140, sub, font(26), DIM, a)
    a4 = ease((t - 1.8) / 0.6) * out
    text_c(d, 820, "Live runs: real models, real TrueForge sessions, real edits and test output on Flask 3.1.3.",
           font(28), DIM, a4)
    text_c(d, 866, "Clicks and keystrokes are scripted for the recording · model wait time is fast-forwarded and badged.",
           font(26), DIM, a4)
    return img


def card_arch(t, dur):
    img, d = backdrop(t)
    out = 1 - ease((t - (dur - 0.5)) / 0.5)
    text_c(d, 110, "Architecture on TrueForge", font(64, True), FG, ease(t / 0.6) * out)
    boxes = [
        (140, "VS Code extension", ["inline edit · agent panel", "per-hunk diff review", "undo per change / run"], ACCENT),
        (740, "TrueForge (local)", ["agent loop · sessions", "tool approvals · compaction", "deferred tools · fallback"], ACCENT2),
        (1340, "Model providers", ["OpenRouter Nemotron", "Gemini Flash", "any TrueForge provider"], (160, 220, 140)),
    ]
    for i, (x, title, lines, col) in enumerate(boxes):
        a = ease((t - 0.4 - 0.45 * i) / 0.6) * out
        y = 330 + int(30 * (1 - a))
        fillc = tuple(int(c * a + b * (1 - a)) for c, b in zip((24, 32, 56), BG))
        edge = tuple(int(c * a + b * (1 - a)) for c, b in zip(col, BG))
        d.rounded_rectangle((x, y, x + 440, y + 300), 20, fill=fillc, outline=edge, width=4)
        text_l(d, x + 30, y + 26, title, font(38, True), FG, a)
        for j, ln in enumerate(lines):
            text_l(d, x + 30, y + 110 + j * 50, ln, font(28), DIM, a)
    # arrows
    for i, (x0, label) in enumerate([(580, "MCP tools  ⇄  127.0.0.1 + bearer"), (1180, "model calls")]):
        a = ease((t - 1.6 - 0.4 * i) / 0.5) * out
        if a <= 0:
            continue
        L = int(160 * a)
        col = tuple(int(c * a + b * (1 - a)) for c, b in zip(FG, BG))
        d.line((x0, 480, x0 + L, 480), fill=col, width=5)
        if a > 0.95:
            d.polygon([(x0 + 160, 480), (x0 + 145, 470), (x0 + 145, 490)], fill=col)
            d.polygon([(x0, 480), (x0 + 15, 470), (x0 + 15, 490)], fill=col)
    a5 = ease((t - 2.6) / 0.6) * out
    text_c(d, 720, "propose_edit needs TrueForge approval → the approval IS the diff review → nothing reaches disk unaccepted",
           font(30), ACCENT, a5)
    text_c(d, 790, "The extension never calls a model provider directly. Keys live only in TrueForge.", font(28), DIM, a5)
    return img


def card_section(t, dur, title, sub):
    img, d = backdrop(t)
    a = ease(t / 0.5) * (1 - ease((t - (dur - 0.4)) / 0.4))
    bar = int(260 * a)
    d.rectangle((W / 2 - bar / 2, 430, W / 2 + bar / 2, 436), fill=ACCENT)
    text_c(d, 460 - 20 * (1 - a), title, font(110, True), FG, a)
    text_c(d, 620, sub, font(40), DIM, a)
    return img


def card_outro(t, dur):
    img, d = backdrop(t)
    a = ease(t / 0.6)
    b = ease((t - 0.5) / 0.6)
    out = 1 - ease((t - (dur - 0.6)) / 0.6)
    text_c(d, 340, "Forge Agent", font(100, True), FG, a * out)
    text_c(d, 500, "github.com/positron-nb/starDust_forge", mono(48), ACCENT, b * out)
    text_c(d, 600, "MIT licensed  ·  setup from a clean clone in the README", font(32), DIM, b * out)
    text_c(d, 700, "Team StarDust", font(36, True), FG, b * out)
    return img


CARDS = {"intro": (card_intro, 4.5), "overview": (card_overview, 5.0), "arch": (card_arch, 6.5),
         "section": (card_section, 2.0), "outro": (card_outro, 4.5)}


def render_card(seg, path, tmp):
    fn, dur = CARDS[seg["card"]]
    dur = seg.get("dur", dur)
    fdir = os.path.join(tmp, os.path.basename(path) + "_f")
    os.makedirs(fdir, exist_ok=True)
    n = int(dur * FPS)
    for i in range(n):
        t = i / FPS
        img = fn(t, dur, seg["title"], seg["sub"]) if seg["card"] == "section" else fn(t, dur)
        img.save(os.path.join(fdir, f"{i:05d}.png"))
    run([FFMPEG, "-y", "-v", "error", "-framerate", str(FPS), "-i", os.path.join(fdir, "%05d.png"),
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "128k", path])
    return dur


# ---------------------------------------------------------------- footage
def caption_png(path, caption, sub, speed):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    h = 120 if sub else 84
    d.rectangle((0, H - h, W, H), fill=(8, 12, 24, 215))
    d.rectangle((0, H - h, 8, H), fill=ACCENT + (255,))
    d.text((36, H - h + 14), caption, font=font(40, True), fill=FG + (255,))
    if sub:
        d.text((36, H - h + 66), sub, font=font(28), fill=DIM + (255,))
    if speed and speed > 1:
        s = f"{speed:g}×  fast-forward"
        f = font(32, True)
        w = d.textlength(s, font=f)
        d.rounded_rectangle((W - w - 70, H - h + 22, W - 30, H - h + 76), 12, fill=ACCENT + (255,))
        d.text((W - w - 50, H - h + 26), s, font=f, fill=(20, 20, 20, 255))
    img.save(path)


def render_clip(seg, path, tmp):
    start, end = tsec(seg["start"]), tsec(seg["end"])
    speed = float(seg.get("speed", 1))
    dur = (end - start) / speed
    cap = os.path.join(tmp, os.path.basename(path) + "_cap.png")
    caption_png(cap, seg.get("caption", ""), seg.get("sub", ""), speed)
    fade_out = max(0.0, dur - 0.25)
    # footage sits above the caption band, so captions never cover the terminal
    band = 120 if seg.get("sub") else 84
    # privacy: blur the desktop-notification corner while an OS toast is on screen
    pre = "[0:v]"
    wins = [(max(0.0, a - start), b - start) for a, b in seg.get("blur", []) if b > start and a < end]
    if wins:
        en = "+".join(f"between(t\\,{a:.2f}\\,{b:.2f})" for a, b in wins)
        x, y, w, h = seg.get("blur_box", [2060, 1280, 820, 520])
        pre = (f"[0:v]setpts=PTS-STARTPTS,split[s0][s1];[s1]crop={w}:{h}:{x}:{y},boxblur=24:6[bl];"
               f"[s0][bl]overlay={x}:{y}:enable='{en}'[pv];[pv]")
    vf = (f"{pre}setpts=(PTS-STARTPTS)/{speed},scale={W}:{H - band}:force_original_aspect_ratio=decrease,"
          f"pad={W}:{H}:(ow-iw)/2:0:color=0x0b1020,fps={FPS},format=yuv420p[v];"
          f"[1:v]format=rgba,fade=in:st=0:d=0.4:alpha=1[c];"
          f"[v][c]overlay=0:0:shortest=1,fade=in:st=0:d=0.25,fade=out:st={fade_out:.2f}:d=0.25[out]")
    run([FFMPEG, "-y", "-v", "error", "-ss", str(start), "-t", str(end - start), "-i", seg["src"],
         "-loop", "1", "-framerate", str(FPS), "-i", cap,
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
         "-filter_complex", vf, "-map", "[out]", "-map", "2:a", "-t", f"{dur:.3f}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "128k", path])
    return dur


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-3000:])


def probe(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    spec_path, out = sys.argv[1], sys.argv[2]
    spec = json.load(open(spec_path, encoding="utf-8"))
    base = os.path.dirname(os.path.abspath(spec_path))
    tmp = tempfile.mkdtemp(prefix="forgevid_")
    parts, pos, marks = [], 0.0, []
    for i, seg in enumerate(spec["segments"]):
        p = os.path.join(tmp, f"seg{i:02d}.mp4")
        if "card" in seg:
            render_card(seg, p, tmp)
        else:
            if not os.path.isabs(seg["src"]):
                seg["src"] = os.path.join(base, seg["src"])
            render_clip(seg, p, tmp)
        d = probe(p)
        label = seg.get("card") or seg.get("caption", "")
        print(f"{fmt(pos):>6}  {d:6.1f}s  {label}" + (f"   [{seg['mark']}]" if seg.get("mark") else ""))
        if seg.get("mark"):
            marks.append((seg["mark"], fmt(pos)))
        parts.append(p)
        pos += d
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy",
         "-movflags", "+faststart", out])
    total = probe(out)
    print(f"\nTOTAL {fmt(total)} ({total:.1f}s)  ->  {out}")
    if total > 240:
        print("WARNING: longer than 4:00")
    for m, ts in marks:
        print(f"MARK {m} {ts}")


if __name__ == "__main__":
    main()
