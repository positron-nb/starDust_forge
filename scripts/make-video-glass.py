"""Glass-style demo video with voice-over and crossfades.

usage: python scripts/make-video-glass.py <take-dir> <out.mp4>

The plan below cuts the real screen recordings (take-*.mkv in <take-dir>) into segments.
Footage is never altered beyond cropping/scaling, privacy blur of OS toasts and labelled
fast-forwards. Narration WAVs come from <take-dir>/vo/<key>.wav (see vo/lines.json).
Prints where every segment and scorecard mark starts in the final video.
"""
import glob, json, math, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
WX, WY, WW, WH = 224, 30, 1472, 920          # footage window
XF = 0.45                                     # crossfade length
FD = "C:/Windows/Fonts"
BLUE, PURPLE, ORANGE, RED, GREEN = (10, 132, 255), (191, 90, 242), (255, 159, 10), (255, 69, 58), (48, 209, 88)
TEAL, PINK, INDIGO = (100, 210, 255), (255, 55, 95), (94, 92, 230)
TAGC = {"A": BLUE, "B": PURPLE, "X": RED, "C": ORANGE}
TAGT = {"A": "TASK A", "B": "TASK B", "X": "CANCEL", "C": "TASK C"}

FFDIR = glob.glob(os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "ffmpeg-*", "bin"))[0]
FFMPEG, FFPROBE = os.path.join(FFDIR, "ffmpeg.exe"), os.path.join(FFDIR, "ffprobe.exe")


def F(size, w="regular"):
    return ImageFont.truetype(os.path.join(FD, {"regular": "segoeui.ttf", "semibold": "seguisb.ttf", "bold": "segoeuib.ttf",
                                                "light": "segoeuil.ttf", "semilight": "segoeuisl.ttf"}[w]), size)


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + " ".join(cmd)[:600] + "\n" + r.stderr[-2500:])


def probe(p):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                capture_output=True, text=True).stdout.strip())


def fmt(s):
    s = int(round(s))
    return f"{s // 60}:{s % 60:02d}"


# ------------------------------------------------------------------ drawing helpers
def rmask(size, r, s=3):
    w, h = size
    m = Image.new("L", (w * s, h * s), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * s - 1, h * s - 1), r * s, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def ring(size, r, color, width=2, s=3):
    w, h = size
    m = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
    ImageDraw.Draw(m).rounded_rectangle((width, width, w * s - 1 - width, h * s - 1 - width), r * s, outline=color, width=width * s)
    return m.resize((w, h), Image.LANCZOS)


def aurora(t=0.0, dark=0.35):
    w, h = 384, 216
    base = Image.new("RGBA", (w, h), (7, 9, 20, 255))
    lay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for col, cx, cy, r, ph in [(INDIGO, .20, .22, .44, 0), (PINK, .86, .80, .36, 1.3), (TEAL, .88, .14, .28, 2.1), (PURPLE, .12, .88, .32, 3.4)]:
        x = (cx + .04 * math.sin(t * .35 + ph)) * w
        y = (cy + .05 * math.cos(t * .30 + ph)) * h
        rr = r * w
        d.ellipse((x - rr, y - rr * .78, x + rr, y + rr * .78), fill=col + (150,))
    lay = lay.filter(ImageFilter.GaussianBlur(42))
    img = Image.alpha_composite(base, lay)
    img = Image.blend(img, Image.new("RGBA", (w, h), (6, 8, 18, 255)), dark)
    return img.resize((W, H), Image.BICUBIC)


def shadow_on(img, box, r=30, blur=34, alpha=120, dy=16):
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + dy, x1, y1 + dy), r, fill=(0, 0, 0, alpha))
    return Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(blur)))


def glass_on(img, box, r=30, a=1.0, tint=34, border=80, blur=0):
    """Frosted panel: (optional real blur of what is behind) + white tint + hairline border."""
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    if w <= 2 or h <= 2:
        return img
    panel = img.crop((x0, y0, x1, y1))
    if blur:
        small = panel.resize((max(1, w // 4), max(1, h // 4)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(blur / 4))
        panel = small.resize((w, h), Image.BICUBIC)
        panel = ImageEnhance.Brightness(panel).enhance(1.1)
    panel = Image.alpha_composite(panel, Image.new("RGBA", (w, h), (255, 255, 255, int(tint * a))))
    panel = Image.alpha_composite(panel, ring((w, h), r, (255, 255, 255, int(border * a)), 1))
    m = rmask((w, h), r)
    if a < 1:
        m = m.point(lambda v: int(v * a))
    out = img.copy()
    out.paste(panel, (x0, y0), m)
    return out


def text(img, xy, s, font, color=(255, 255, 255), a=1.0, anchor="la"):
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).text(xy, s, font=font, fill=color + (int(255 * max(0, min(1, a))),), anchor=anchor)
    return Image.alpha_composite(img, lay)


def chip(img, x, y, label, color, a=1.0, size=22, anchor="l"):
    f = F(size, "bold")
    tw = ImageDraw.Draw(img).textlength(label, font=f)
    w, h = int(tw + 30), size + 18
    if anchor == "c":
        x = int(x - w / 2)
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).rounded_rectangle((x, y, x + w, y + h), h // 2, fill=color + (int(235 * a),))
    img = Image.alpha_composite(img, lay)
    return text(img, (x + w / 2, y + h / 2 + 1), label, f, (255, 255, 255), a, "mm"), w


# ------------------------------------------------------------------ cards
UI_BG = None


def ui_backdrop(t, dur):
    z = 1.0 + 0.035 * (t / max(dur, 0.1))
    im = UI_BG.resize((int(W * z), int(H * z)), Image.BICUBIC)
    ox, oy = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((ox, oy, ox + W, oy + H))


def card_intro(t, dur):
    img = ui_backdrop(t, dur)
    a = ease(t / .7)
    s = .96 + .04 * a
    pw, ph = int(1180 * s), int(470 * s)
    box = ((W - pw) // 2, (H - ph) // 2 - 20 + int(24 * (1 - a)), (W + pw) // 2, (H + ph) // 2 - 20 + int(24 * (1 - a)))
    img = shadow_on(img, box, 40, 40, int(130 * a))
    img = glass_on(img, box, 40, a, tint=30, border=90, blur=40)
    cx = W // 2
    img, _ = chip(img, cx, box[1] + 50, "TRUEFOUNDRY FORGE-A-THON  ·  TECHFEST IIT BOMBAY", INDIGO, ease((t - .3) / .6), 18, "c")
    img = text(img, (cx, box[1] + 205), "Forge Agent", F(124, "bold"), a=ease((t - .35) / .6), anchor="mm")
    img = text(img, (cx, box[1] + 300), "A coding agent in VS Code. Its loop runs on TrueForge.", F(36, "light"), a=ease((t - .6) / .6), anchor="mm")
    x = cx - 380
    for i, (lab, col) in enumerate([("Inline edit", BLUE), ("Agent mode", PURPLE), ("Safe fallback", ORANGE)]):
        b = ease((t - 1.0 - .25 * i) / .5)
        img, w = chip(img, x + i * 270, box[1] + 362 + int(10 * (1 - b)), lab, col, b, 24)
    return img


def card_arch(t, dur):
    img = aurora(t)
    img = text(img, (W // 2, 150), "How it works", F(64, "bold"), a=ease(t / .6), anchor="mm")
    cols = [("VS Code extension", BLUE, ["inline edit · agent panel", "per-hunk diff review", "undo per change / run"]),
            ("TrueForge (local)", PURPLE, ["agent loop · sessions", "approvals · compaction", "deferred tools · fallback"]),
            ("Model providers", ORANGE, ["Gemini · OpenRouter", "any TrueForge provider", "no keys in the extension"])]
    for i, (title, col, lines) in enumerate(cols):
        a = ease((t - .35 - .4 * i) / .6)
        x0 = 150 + i * 560
        box = (x0, 300 + int(30 * (1 - a)), x0 + 480, 640 + int(30 * (1 - a)))
        img = shadow_on(img, box, 34, 30, int(110 * a))
        img = glass_on(img, box, 34, a, tint=26, border=85)
        img, _ = chip(img, box[0] + 34, box[1] + 34, title.upper(), col, a, 18)
        img = text(img, (box[0] + 34, box[1] + 112), title, F(40, "semibold"), a=a)
        for j, ln in enumerate(lines):
            img = text(img, (box[0] + 34, box[1] + 190 + j * 46), ln, F(28, "light"), (230, 232, 240), a)
    for i in range(2):
        a = ease((t - 1.6 - .3 * i) / .5)
        x0, x1, y = 150 + i * 560 + 480 + 8, 150 + (i + 1) * 560 - 8, 470
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        d.line((x0, y, x0 + (x1 - x0) * a, y), fill=(255, 255, 255, int(200 * a)), width=4)
        if a > .05:
            p = (t * .8 + i * .5) % 1.0
            px = x0 + (x1 - x0) * p
            d.ellipse((px - 7, y - 7, px + 7, y + 7), fill=TEAL + (int(255 * a),))
        img = Image.alpha_composite(img, lay)
    a = ease((t - 2.4) / .6)
    box = (W // 2 - 640, 760, W // 2 + 640, 860)
    img = glass_on(img, box, 50, a, tint=30, border=90)
    img = text(img, (W // 2, 810), "MCP tools on 127.0.0.1 + bearer token   ·   every edit is an approval = a per-hunk review", F(30, "semibold"), a=a, anchor="mm")
    return img


def card_overview(t, dur):
    img = aurora(t + 7)
    img = text(img, (W // 2, 230), "Three tasks on Flask 3.1.3", F(64, "bold"), a=ease(t / .6), anchor="mm")
    items = [("A", "Inline edit", "get_debug_flag · per-hunk diff"), ("B", "Agent mode", "flask config · 3 files, unprompted"),
             ("C", "Provider failure", "dead endpoint → automatic fallback")]
    for i, (k, name, sub) in enumerate(items):
        a = ease((t - .3 - .3 * i) / .6)
        x0 = 170 + i * 540
        box = (x0, 360 + int(30 * (1 - a)), x0 + 500, 620 + int(30 * (1 - a)))
        img = shadow_on(img, box, 34, 30, int(110 * a))
        img = glass_on(img, box, 34, a, tint=26, border=85)
        img, _ = chip(img, box[0] + 34, box[1] + 36, TAGT[k], TAGC[k], a, 18)
        img = text(img, (box[0] + 34, box[1] + 118), name, F(46, "semibold"), a=a)
        img = text(img, (box[0] + 34, box[1] + 190), sub, F(27, "light"), (230, 232, 240), a)
    a = ease((t - 1.4) / .6)
    img = text(img, (W // 2, 740), "Live runs: real models, real TrueForge sessions, real edits and tests.", F(30, "light"), a=a, anchor="mm")
    img = text(img, (W // 2, 790), "Clicks are scripted for the recording  ·  model wait time is fast-forwarded and labelled.", F(26, "light"), (200, 205, 220), a, "mm")
    return img


def card_section(t, dur, tag, title, sub):
    img = ui_backdrop(t, dur)
    a = ease(t / .55)
    s = .95 + .05 * a
    pw, ph = int(1000 * s), int(330 * s)
    box = ((W - pw) // 2, (H - ph) // 2 + int(20 * (1 - a)), (W + pw) // 2, (H + ph) // 2 + int(20 * (1 - a)))
    img = shadow_on(img, box, 40, 40, int(130 * a))
    img = glass_on(img, box, 40, a, tint=30, border=90, blur=40)
    img, _ = chip(img, W // 2, box[1] + 46, TAGT.get(tag, tag), TAGC.get(tag, BLUE), ease((t - .15) / .5), 20, "c")
    img = text(img, (W // 2, box[1] + 160), title, F(84, "bold"), a=ease((t - .2) / .5), anchor="mm")
    img = text(img, (W // 2, box[1] + 245), sub, F(32, "light"), a=ease((t - .35) / .5), anchor="mm")
    return img


def card_outro(t, dur):
    img = ui_backdrop(t, dur)
    a = ease(t / .6)
    box = (W // 2 - 600, 290 + int(20 * (1 - a)), W // 2 + 600, 790 + int(20 * (1 - a)))
    img = shadow_on(img, box, 44, 40, int(130 * a))
    img = glass_on(img, box, 44, a, tint=30, border=90, blur=40)
    img = text(img, (W // 2, box[1] + 120), "Forge Agent", F(110, "bold"), a=a, anchor="mm")
    b = ease((t - .5) / .6)
    pill = (W // 2 - 430, box[1] + 225, W // 2 + 430, box[1] + 305)
    img = glass_on(img, pill, 40, b, tint=40, border=110)
    img = text(img, (W // 2, box[1] + 265), "github.com/positron-nb/starDust_forge", F(38, "semibold"), a=b, anchor="mm")
    img = text(img, (W // 2, box[1] + 370), "MIT licensed · setup from a clean clone in the README", F(28, "light"), a=b, anchor="mm")
    c = ease((t - .9) / .6)
    img, _ = chip(img, W // 2, box[1] + 420, "TEAM STARDUST", PURPLE, c, 20, "c")
    return img


CARDS = {"intro": card_intro, "arch": card_arch, "overview": card_overview, "section": card_section, "outro": card_outro}


def render_card(seg, dur, path, tmp):
    fdir = os.path.join(tmp, os.path.basename(path) + "_f")
    os.makedirs(fdir, exist_ok=True)
    fn = CARDS[seg["card"]]
    for i in range(int(round(dur * FPS))):
        t = i / FPS
        im = fn(t, dur, seg.get("tag", "A"), seg.get("title", ""), seg.get("sub", "")) if seg["card"] == "section" else fn(t, dur)
        im.convert("RGB").save(os.path.join(fdir, f"{i:05d}.png"))
    run([FFMPEG, "-y", "-v", "error", "-framerate", str(FPS), "-i", os.path.join(fdir, "%05d.png"),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-r", str(FPS), path])


# ------------------------------------------------------------------ footage
def overlay_png(path, capmask_path, seg, speed):
    """Window hairline + caption glass tint/text + speed badge; returns caption card box."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img = Image.alpha_composite(img, _place(ring((WW, WH), 22, (255, 255, 255, 60), 1), WX, WY))
    title, sub, tag = seg.get("caption", ""), seg.get("sub", ""), seg.get("tag")
    ft, fs = F(34, "semibold"), F(24, "regular")
    d = ImageDraw.Draw(img)
    tw = max(d.textlength(title, font=ft), d.textlength(sub, font=fs) if sub else 0)
    chip_w = (d.textlength(TAGT[tag], font=F(18, "bold")) + 30 + 22) if tag else 0
    cw = int(min(1700, max(760, tw + chip_w + 72)))
    cw -= cw % 2                                   # even sizes: the glass crop runs on yuv frames
    ch = 104 if sub else 74
    cx, cy = (W - cw) // 2, 1018 - ch
    cx -= cx % 2
    img = Image.alpha_composite(img, _place(Image.new("RGBA", (cw, ch), (255, 255, 255, 38)), cx, cy, rmask((cw, ch), 26)))
    img = Image.alpha_composite(img, _place(ring((cw, ch), 26, (255, 255, 255, 95), 1), cx, cy))
    x = cx + 30
    if tag:
        img, w = chip(img, x, cy + (ch - 40) // 2, TAGT[tag], TAGC[tag], 1.0, 18)
        x += w + 22
    if sub:
        img = text(img, (x, cy + 14), title, ft)
        img = text(img, (x, cy + 60), sub, fs, (235, 238, 245), .82)
    else:
        img = text(img, (x, cy + ch // 2 + 1), title, ft, anchor="lm")
    if speed > 1.05:
        lab = f"{speed:.0f}×  fast-forward" if speed >= 2.5 else f"{speed:.1f}×  fast-forward"
        fb = F(24, "semibold")
        bw = int(d.textlength(lab, font=fb) + 70)
        bx, by = WX + WW - bw - 22, WY + 20
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(lay).rounded_rectangle((bx, by, bx + bw, by + 48), 24, fill=(18, 18, 24, 190), outline=(255, 255, 255, 80), width=1)
        dd = ImageDraw.Draw(lay)
        for k in range(2):
            ox = bx + 20 + k * 11
            dd.polygon([(ox, by + 15), (ox, by + 33), (ox + 11, by + 24)], fill=ORANGE + (255,))
        img = Image.alpha_composite(img, lay)
        img = text(img, (bx + 50, by + 24), lab, fb, anchor="lm")
    img.save(path)
    rmask((cw, ch), 26).save(capmask_path)
    return cx, cy, cw, ch


def _place(layer, x, y, mask=None):
    full = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    full.paste(layer, (x, y), mask if mask is not None else layer)
    return full


def render_clip(seg, dur, path, tmp, bg_path, winmask_path):
    src, start, end = seg["src"], float(seg["start"]), float(seg["end"])
    content = end - start
    speed = max(1.0, content / dur) if seg.get("ff") else float(seg.get("speed", 1))
    shown = content / speed
    extra = max(0.0, dur - shown)
    ov, cm = path + "_ov.png", path + "_cm.png"
    cx, cy, cw, ch = overlay_png(ov, cm, seg, speed if seg.get("ff") or speed > 1 else 1)
    pre = "[0:v]"
    wins = [(max(0.0, a - start), b - start) for a, b in seg.get("blur", []) if b > start and a < end]
    if wins:
        en = "+".join(f"between(t\\,{a:.2f}\\,{b:.2f})" for a, b in wins)
        pre = ("[0:v]setpts=PTS-STARTPTS,split[s0][s1];[s1]crop=820:520:2060:1280,boxblur=24:6[bl];"
               f"[s0][bl]overlay=2060:1280:enable='{en}'[pv];[pv]")
    tp = f",tpad=stop_mode=clone:stop_duration={extra:.3f}" if extra > 0.02 else ""
    fc = (f"{pre}setpts=(PTS-STARTPTS)/{speed},scale={WW}:{WH}:flags=lanczos,fps={FPS}{tp},format=rgba[v];"
          f"[2:v]format=gray[wm];[v][wm]alphamerge[vr];[1:v]format=rgba[bg];[bg][vr]overlay={WX}:{WY}:shortest=1[comp];"
          f"[comp]split[c1][c2];[c2]crop={cw}:{ch}:{cx}:{cy},gblur=sigma=22,eq=brightness=0.03:saturation=1.15,format=rgba[blr];"
          f"[4:v]format=gray[cmk];[blr][cmk]alphamerge[gl];[c1][gl]overlay={cx}:{cy}[c3];[3:v]format=rgba[ovl];"
          f"[c3][ovl]overlay=0:0,format=yuv420p[out]")
    run([FFMPEG, "-y", "-v", "error", "-ss", f"{start}", "-t", f"{content}", "-i", src,
         "-loop", "1", "-framerate", str(FPS), "-i", bg_path, "-loop", "1", "-framerate", str(FPS), "-i", winmask_path,
         "-loop", "1", "-framerate", str(FPS), "-i", ov, "-loop", "1", "-framerate", str(FPS), "-i", cm,
         "-filter_complex", fc, "-map", "[out]", "-t", f"{dur:.3f}", "-r", str(FPS),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-an", path])
    return speed


# ------------------------------------------------------------------ plan
def plan(D):
    A, B1, B2, C = f"{D}/take-A.mkv", f"{D}/take-B-p1.mkv", f"{D}/take-B4-verify.mkv", f"{D}/take-C.mkv"
    return [
        {"card": "intro", "min": 4.5, "vo": "intro"},
        {"card": "arch", "min": 6.0, "vo": "arch"},
        {"card": "overview", "min": 5.0, "vo": "overview"},
        {"card": "section", "tag": "A", "title": "Inline edit", "sub": "get_debug_flag in src/flask/helpers.py", "min": 2.4, "vo": "a_sec"},
        {"src": A, "start": 3.0, "end": 9.5, "tag": "A", "caption": "Select, Ctrl+Alt+E, describe the change", "sub": "get_debug_flag → instruction typed into the inline-edit box", "vo": "a_inst", "mark": "A1"},
        {"src": A, "start": 9.5, "end": 123.5, "ff": True, "min": 4.5, "tag": "A", "caption": "Gemini 3.5 Flash proposes an edit through TrueForge", "sub": "progress streams into the panel", "vo": "a_ff", "blur": [[88.2, 91.2]]},
        {"src": A, "start": 123.5, "end": 134.5, "tag": "A", "caption": "Per-hunk diff review", "sub": "2 hunks accepted one at a time · nothing on disk before Apply", "vo": "a_rev", "mark": "B2a"},
        {"src": A, "start": 134.5, "end": 142.5, "speed": 2, "tag": "A", "caption": "Applied", "sub": "the panel offers Undo agent run"},
        {"src": A, "start": 142.5, "end": 160.0, "speed": 1.4, "tag": "A", "caption": "Verified on screen", "sub": "off · OFF · n · N · 0 → False   ·   1 · yes → True   ·   35 passed", "vo": "a_ver"},
        {"card": "section", "tag": "B", "title": "Agent mode", "sub": "the official instruction · no file names given", "min": 2.4, "vo": "b_sec"},
        {"src": B1, "start": 3.0, "end": 9.5, "tag": "B", "caption": "Task B instruction in the Forge panel", "sub": "the agent must find the code, the tests and the docs itself", "vo": "b_inst", "mark": "A2"},
        {"src": B1, "start": 9.5, "end": 16.0, "tag": "B", "caption": "Context assembly", "sub": "BM25 + import graph · token budget · a reason for every pick", "vo": "b_ctx", "mark": "B1"},
        {"src": B1, "start": 16.0, "end": 114.5, "ff": True, "min": 4.0, "tag": "B", "caption": "Plans with task_state, reads what it needs", "sub": "Gemini 3.1 Flash-Lite", "vo": "b_ff"},
        {"src": B1, "start": 114.5, "end": 125.0, "tag": "B", "caption": "Review 1 · src/flask/cli.py", "sub": "the TrueForge approval pause is this diff review", "vo": "b_rev1"},
        {"src": B1, "start": 125.0, "end": 158.5, "ff": True, "min": 1.8, "tag": "B", "caption": "Agent continues"},
        {"src": B1, "start": 158.5, "end": 162.5, "tag": "B", "caption": "Review 2 · tests/test_cli.py", "sub": "new test_config_command", "vo": "b_rev2"},
        {"src": B1, "start": 162.5, "end": 204.0, "ff": True, "min": 1.8, "tag": "B", "caption": "Agent continues"},
        {"src": B1, "start": 204.0, "end": 208.0, "tag": "B", "caption": "Review 3 · docs/cli.rst", "sub": "documented with the other built-in commands", "vo": "b_rev3"},
        {"src": B1, "start": 208.0, "end": 231.0, "ff": True, "min": 3.0, "tag": "B", "caption": "5 reviews · 3 files", "sub": "all found without being told", "vo": "b_more"},
        {"src": B2, "start": 5.0, "end": 12.0, "tag": "B", "caption": "The same run inside TrueForge", "sub": "localhost:8790 · every turn and tool call", "vo": "b_sess", "mark": "B4"},
        {"src": B2, "start": 12.0, "end": 33.0, "ff": True, "min": 2.2, "tag": "B", "caption": "To the first turn"},
        {"src": B2, "start": 33.0, "end": 40.0, "tag": "B", "caption": "Provider 503 → recovery turn", "sub": "the run continues on its own", "vo": "b_retry"},
        {"src": B2, "start": 40.0, "end": 50.0, "ff": True, "min": 2.0, "tag": "B", "caption": "Scrolling"},
        {"src": B2, "start": 50.0, "end": 58.0, "tag": "B", "caption": "Deferred tools", "sub": "Listing tools → get_tool_info → call_tool", "vo": "b_defer"},
        {"src": B2, "start": 63.0, "end": 67.0, "tag": "B", "caption": "Verify · git status", "sub": "3 files changed by the agent", "vo": "b_git"},
        {"src": B2, "start": 67.5, "end": 72.0, "tag": "B", "caption": "pytest tests/test_cli.py → 59 passed", "sub": "58 existing + the agent's new test", "vo": "b_test"},
        {"src": B2, "start": 81.0, "end": 91.5, "tag": "B", "caption": "flask --help lists config · secrets masked", "sub": "API_TOKEN · DATABASE_PASSWORD · SECRET_KEY → \"***\"", "vo": "b_cfg"},
        {"src": B2, "start": 95.0, "end": 102.5, "tag": "B", "caption": "Undo Agent Run", "sub": "all three files reverted · working tree clean", "vo": "b_undo", "mark": "B2b"},
        {"card": "section", "tag": "X", "title": "Cancellation", "sub": "stop a run mid-flight · nothing half-applied", "min": 2.2, "vo": "x_sec"},
        {"src": C, "start": 4.0, "end": 12.0, "ff": True, "min": 2.2, "tag": "X", "caption": "A new edit request", "sub": "agent panel · Gemini Flash-Lite", "vo": "x_req", "mark": "A3"},
        {"src": C, "start": 12.0, "end": 18.5, "tag": "X", "caption": "Cancel while the diff waits for review", "sub": "Ctrl+Alt+C · unapplied edits discarded", "vo": "x_cancel"},
        {"src": C, "start": 22.3, "end": 25.5, "tag": "X", "caption": "git status: working tree clean", "vo": "x_clean"},
        {"card": "section", "tag": "C", "title": "Provider failure", "sub": "a dead endpoint first in the fallback list", "min": 2.4, "vo": "c_sec"},
        {"src": C, "start": 28.0, "end": 32.5, "tag": "C", "caption": "forge.models: dead endpoint first", "sub": "broken/dead-model → gemini-3-1-flash-lite", "vo": "c_set"},
        {"src": C, "start": 33.8, "end": 38.5, "tag": "C", "caption": "Same inline edit as Task A", "vo": "c_inst"},
        {"src": C, "start": 38.5, "end": 51.5, "ff": True, "min": 4.0, "tag": "C", "caption": "Unreachable → automatic fallback", "sub": "the panel reports the failure and the switch", "vo": "c_fb", "blur": [[42.0, 48.2]], "mark": "B3"},
        {"src": C, "start": 51.5, "end": 60.0, "speed": 1.4, "tag": "C", "caption": "Reject every hunk", "sub": "rejected hunks are never written", "vo": "c_rej"},
        {"src": C, "start": 60.0, "end": 75.0, "ff": True, "min": 3.0, "tag": "C", "caption": "Rejected again · run cancelled", "vo": "c_again"},
        {"src": C, "start": 75.0, "end": 82.0, "tag": "C", "caption": "No files changed · git status clean", "vo": "c_clean"},
        {"card": "outro", "min": 5.0, "vo": "outro"},
    ]


def music(total, path):
    """Soft synth pad (Cmaj7 · Am7 · Fmaj7 · G6, 4 s each) with gentle swells."""
    ch = [[130.81, 261.63, 329.63, 392.00, 493.88], [110.00, 220.00, 261.63, 329.63, 392.00],
          [87.31, 174.61, 220.00, 261.63, 329.63], [98.00, 196.00, 246.94, 293.66, 329.63]]

    def f(k):
        return f"if(lt(mod(t\\,16)\\,4)\\,{ch[0][k]}\\,if(lt(mod(t\\,16)\\,8)\\,{ch[1][k]}\\,if(lt(mod(t\\,16)\\,12)\\,{ch[2][k]}\\,{ch[3][k]})))"
    env = "pow(sin(PI*mod(t\\,4)/4)\\,2)"
    expr = "+".join(f"{0.11 if k == 0 else 0.07}*sin(2*PI*{f(k)}*t)" for k in range(5))
    run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"aevalsrc=({expr})*(0.55+0.45*{env}):s=48000:d={total + 1:.2f}",
         "-af", f"lowpass=f=1400,aecho=0.8:0.6:90|170:0.25|0.18,afade=t=in:d=2,afade=t=out:st={max(0, total - 3):.2f}:d=3,volume=0.55",
         "-ac", "2", path])


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    D, out = sys.argv[1].rstrip("/\\"), sys.argv[2]
    durs = json.load(open(os.path.join(D, "vo", "durations.json")))
    tmp = os.path.join(D, "glass-cache")          # rendered segments are reused across runs
    os.makedirs(tmp, exist_ok=True)
    global UI_BG
    # backdrops: blurred real UI for title cards, aurora for footage
    fr = os.path.join(tmp, "uiframe.png")
    run([FFMPEG, "-v", "error", "-y", "-ss", "118", "-i", f"{D}/take-B-p1.mkv", "-frames:v", "1", "-vf", f"scale={W}:{H}", fr])
    ui = Image.open(fr).convert("RGBA").filter(ImageFilter.GaussianBlur(28))
    UI_BG = Image.blend(ui, aurora(0, .2), .55)
    bg = aurora(0)
    bg = shadow_on(bg, (WX, WY, WX + WW, WY + WH), 26, 36, 150, 18)
    bg_path, wm_path = os.path.join(tmp, "bg.png"), os.path.join(tmp, "winmask.png")
    bg.convert("RGB").save(bg_path)
    rmask((WW, WH), 22).save(wm_path)

    segs = plan(D)
    parts, timeline, pos = [], [], 0.0
    for i, s in enumerate(segs):
        vo = durs.get(s.get("vo", ""), 0.0)
        need = (vo + 1.05) if vo else 0.0
        if "card" in s:
            dur = max(s.get("min", 3.0), need)
        else:
            content = s["end"] - s["start"]
            natural = s.get("min", 2.0) if s.get("ff") else content / float(s.get("speed", 1))
            dur = max(natural, need)
        p = os.path.join(tmp, f"seg{i:02d}.mp4")
        if os.path.exists(p) and os.path.getsize(p) > 1000 and abs(probe(p) - dur) < 0.1:
            spd = 0
        elif "card" in s:
            render_card(s, dur, p, tmp)
            spd = 1
        else:
            spd = render_clip(s, dur, p, tmp, bg_path, wm_path)
        d = probe(p)
        start = pos
        timeline.append((start, d, s))
        label = s.get("card") or s.get("caption", "")
        print(f"{fmt(start):>6} {d:6.2f}s {('x' + format(spd, '.1f')) if spd != 1 else '':>6}  {label}" + (f"  [{s['mark']}]" if s.get("mark") else ""), flush=True)
        parts.append(p)
        pos += d - XF
    total = pos + XF
    # crossfade chain
    inputs, fc, prev, off = [], [], "[0:v]", 0.0
    for p in parts:
        inputs += ["-i", p]
    for k in range(1, len(parts)):
        off += timeline[k - 1][1] - XF
        lab = f"[x{k}]"
        fc.append(f"{prev}[{k}:v]xfade=transition=fade:duration={XF}:offset={off:.3f}{lab}")
        prev = lab
    vpath = os.path.join(tmp, "video.mp4")
    run([FFMPEG, "-y", "-v", "error", *inputs, "-filter_complex", ";".join(fc), "-map", prev,
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), vpath])
    # narration track
    vin, vf = [], []
    n = 0
    for start, d, s in timeline:
        if s.get("vo") in durs:
            lead = 0.55 if start == 0 else 0.35 + XF * 0.5
            vin += ["-i", os.path.join(D, "vo", s["vo"] + ".wav")]
            ms = int((start + lead) * 1000)
            vf.append(f"[{n}:a]adelay={ms}|{ms},aformat=channel_layouts=stereo[a{n}]")
            n += 1
    mix = "".join(f"[a{k}]" for k in range(n)) + f"amix=inputs={n}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.3f}[voice]"
    mpath = os.path.join(tmp, "pad.wav")
    music(total, mpath)
    vin += ["-i", mpath]
    graph = ";".join(vf) + ";" + mix + f";[voice]asplit[v1][v2];[{n}:a]aformat=channel_layouts=stereo[pad];" \
        "[pad][v2]sidechaincompress=threshold=0.015:ratio=6:attack=30:release=600:makeup=1[duck];" \
        "[v1][duck]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]"
    apath = os.path.join(tmp, "audio.m4a")
    run([FFMPEG, "-y", "-v", "error", *vin, "-filter_complex", graph, "-map", "[aout]", "-c:a", "aac", "-b:a", "160k", apath])
    run([FFMPEG, "-y", "-v", "error", "-i", vpath, "-i", apath, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy",
         "-shortest", "-movflags", "+faststart", out])
    print(f"\nTOTAL {fmt(probe(out))} ({probe(out):.1f}s) -> {out}")
    for start, d, s in timeline:
        if s.get("mark"):
            print(f"MARK {s['mark']} {fmt(start + XF / 2)}")


if __name__ == "__main__":
    main()
