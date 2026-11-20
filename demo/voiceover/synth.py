import asyncio, json, os, subprocess, glob, sys, time
import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE = sys.argv[1] if len(sys.argv) > 1 else "en-US-AndrewNeural"
lines = json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))
ffbin = glob.glob(os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "ffmpeg-*", "bin"))[0]


def dur(path):
    out = subprocess.run([os.path.join(ffbin, "ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


async def main():
    durs, failed = {}, []
    for key, text in lines.items():
        mp3, wav = os.path.join(HERE, f"{key}.mp3"), os.path.join(HERE, f"{key}.wav")
        ok = os.path.exists(mp3) and os.path.getsize(mp3) > 1000
        for attempt in range(6):
            if ok:
                break
            try:
                await edge_tts.Communicate(text, VOICE).save(mp3)
                ok = os.path.getsize(mp3) > 1000
            except Exception as e:
                print("retry", key, attempt, str(e)[:60], flush=True)
            if not ok:
                await asyncio.sleep(2 + attempt * 2)
        if not ok:
            failed.append(key)
            continue
        subprocess.run([os.path.join(ffbin, "ffmpeg"), "-v", "error", "-y", "-i", mp3, "-ar", "48000", "-ac", "1", wav], check=True)
        durs[key] = round(dur(wav), 2)
        print(key, durs[key], flush=True)
        await asyncio.sleep(0.6)
    json.dump(durs, open(os.path.join(HERE, "durations.json"), "w"), indent=1)
    print("total speech", round(sum(durs.values()), 1), "failed", failed)

asyncio.run(main())
