import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import heroImg from "@/assets/hero-salad.jpg";
import { identify } from "@/lib/food.functions";
import type { FoodResult } from "@/lib/ai-gateway.server";
import { useArduino } from "@/hooks/use-arduino";

const FRESH: Record<string, { label: string; bar: string }> = {
  APPEARS_FRESH: { label: "🟢 Appears fresh", bar: "bg-mint" },
  QUESTIONABLE: { label: "🟡 Questionable quality", bar: "bg-lemon" },
  POSSIBLE_SPOILAGE: { label: "🟠 Possible spoilage", bar: "bg-tang" },
  VISIBLE_SPOILAGE: { label: "🔴 Visible spoilage detected", bar: "bg-berry" },
  CANNOT_DETERMINE: { label: "⚪ Cannot determine", bar: "bg-ink/40" },
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FoodVision AI — Identify any food from a photo" },
      {
        name: "description",
        content:
          "Point your camera or drop a photo to identify foods with confidence scores, alternatives and nutrition.",
      },
      { property: "og:title", content: "FoodVision AI — Identify any food from a photo" },
      {
        property: "og:description",
        content: "Live camera, upload or drag & drop food recognition with confidence scores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Scan = { id: string; thumb: string; name: string; emoji: string; confidence: number };

const altColors = ["bg-berry/70", "bg-tang/70", "bg-lav/70"];
const itemColors = [
  ["bg-mint/20", "text-mint"],
  ["bg-berry/10", "text-berry"],
  ["bg-sky/10", "text-sky"],
  ["bg-tang/10", "text-tang"],
];

async function fileToDataUrl(file: File, max = 1280): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

function thumbOf(dataUrl: string): Promise<string> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const s = Math.min(img.width, img.height);
      c.getContext("2d")!.drawImage(
        img,
        (img.width - s) / 2,
        (img.height - s) / 2,
        s,
        s,
        0,
        0,
        96,
        96,
      );
      res(c.toDataURL("image/jpeg", 0.7));
    };
    img.src = dataUrl;
  });
}

function Index() {
  const run = useServerFn(identify);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const scanRequestRef = useRef(0);
  const [camOn, setCamOn] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<FoodResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [history, setHistory] = useState<Scan[]>([]);
  const [liveBusy, setLiveBusy] = useState(false);
  const smoothRef = useRef<FoodResult[]>([]);
  const lastEnvRef = useRef<{ t: number; h: number } | null>(null);
  const sensor = useArduino();
  const { getContext } = sensor;
  const serialHint = false;

  useEffect(() => {
    try {
      setHistory(JSON.parse(localStorage.getItem("fv-history") || "[]"));
    } catch {
      // Ignore malformed saved history and start with an empty list.
    }
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const stopCam = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    smoothRef.current = [];
    setCamOn(false);
  };

  const startCam = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = s;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreview(null);
      smoothRef.current = [];
      setCamOn(true);
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = s;
      });
    } catch {
      setError("Camera access was blocked or isn't available. You can upload a photo instead.");
    }
  };

  const analyze = useCallback(
    async (dataUrl: string, save = true, requestId?: number) => {
      const currentRequest = requestId ?? ++scanRequestRef.current;
      setPreview(dataUrl);
      setLoading(true);
      setError(null);
      try {
        const ctx = getContext();
        lastEnvRef.current = ctx ? { t: ctx.temperature, h: ctx.humidity } : null;
        const r = await run({ data: { image: dataUrl, sensor: ctx } });
        if (currentRequest !== scanRequestRef.current) return;
        setResult(r);
        if (r.isFood && save) {
          const scan: Scan = {
            id: crypto.randomUUID(),
            thumb: await thumbOf(dataUrl),
            name: r.name,
            emoji: r.emoji,
            confidence: r.confidence,
          };
          setHistory((h) => {
            const next = [scan, ...h].slice(0, 8);
            localStorage.setItem("fv-history", JSON.stringify(next));
            return next;
          });
        }
      } catch (e) {
        if (currentRequest === scanRequestRef.current) {
          setError(e instanceof Error ? e.message : "Something went wrong.");
        }
      } finally {
        if (currentRequest === scanRequestRef.current) setLoading(false);
      }
    },
    [run, getContext],
  );

  // Live scanning: sample a compressed frame, one request in flight at a time,
  // at most ~3 per second, smoothed over recent predictions.
  useEffect(() => {
    if (!camOn) return;
    let active = true;
    (async () => {
      while (active) {
        const started = Date.now();
        const v = videoRef.current;
        if (v && v.videoWidth) {
          const s = Math.min(1, 512 / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement("canvas");
          c.width = Math.round(v.videoWidth * s);
          c.height = Math.round(v.videoHeight * s);
          c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
          setLiveBusy(true);
          try {
            const r = await run({
              data: { image: c.toDataURL("image/jpeg", 0.7), sensor: getContext() },
            });
            if (!active) break;
            setError(null);
            const buf = (smoothRef.current = [...smoothRef.current, r].slice(-5));
            const counts = new Map<string, number>();
            buf.forEach((x) =>
              counts.set(x.name.toLowerCase(), (counts.get(x.name.toLowerCase()) ?? 0) + 1),
            );
            const stable = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
            const same = buf.filter((x) => x.name.toLowerCase() === stable);
            const latestSame = same[same.length - 1]!;
            const avgConf = same.reduce((a, x) => a + x.confidence, 0) / same.length;
            setResult({ ...latestSame, confidence: avgConf });
          } catch (e) {
            if (!active) break;
            setError(e instanceof Error ? e.message : "Live analysis failed.");
            await new Promise((res) => setTimeout(res, 3000));
          } finally {
            setLiveBusy(false);
          }
        }
        const wait = 333 - (Date.now() - started);
        await new Promise((res) => setTimeout(res, Math.max(wait, 50)));
      }
    })();
    return () => {
      active = false;
    };
  }, [camOn, run, getContext]);

  // Uploaded photo: re-assess when smoothed sensor values change significantly.
  useEffect(() => {
    if (camOn || !preview || loading || !result) return;
    const ctx = getContext();
    const prev = lastEnvRef.current;
    const changed =
      ctx &&
      (!prev || Math.abs(ctx.temperature - prev.t) >= 1.5 || Math.abs(ctx.humidity - prev.h) >= 5);
    if (changed) analyze(preview, false);
  }, [sensor.latest, camOn, preview, loading, result, getContext, analyze]);

  const onFile = async (f?: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError("Please choose an image file.");
    if (f.size > 15_000_000) return setError("That image is over 15MB — try a smaller one.");
    stopCam();
    const requestId = ++scanRequestRef.current;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = URL.createObjectURL(f);
    setPreview(previewUrlRef.current);
    setResult(null);
    setLoading(true);
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(f);
      const pendingAnalysis = analyze(dataUrl, true, requestId);
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      await pendingAnalysis;
    } catch {
      if (requestId === scanRequestRef.current) {
        setLoading(false);
        setError("Couldn't read that image.");
      }
    }
  };

  const conf = result ? Math.round(result.confidence) : 0;

  return (
    <div className="min-h-screen w-full">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b-4 border-ink bg-cream px-5 py-4 md:px-8">
        <div className="flex items-center gap-2">
          <span className="pop grid h-10 w-10 place-items-center rounded-xl bg-berry text-lg">
            🍎
          </span>
          <span className="text-2xl font-bold tracking-tight">
            FoodVision<span className="text-berry"> AI</span>
          </span>
        </div>
        <span className="hidden font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground sm:block">
          Camera · Upload · Drop
        </span>
      </header>

      <main className="mx-auto max-w-360 px-5 py-8 md:px-8">
        <section className="mb-10 grid items-center gap-10 lg:grid-cols-2">
          <div>
            <span className="pop mb-6 inline-flex items-center gap-2 rounded-full bg-lemon px-4 py-1.5 text-sm font-bold">
              📸 {history.length} scans saved on this device
            </span>
            <h1 className="mb-5 text-5xl font-bold leading-[0.95] tracking-tight md:text-[64px]">
              Point your phone.
              <br />
              Know your <span className="text-berry">food.</span>
            </h1>
            <p className="mb-8 max-w-md text-lg text-muted-foreground">
              Live camera, upload, or drag &amp; drop — FoodVision tells you exactly what's on your
              plate, with confidence scores you can actually trust.
            </p>
            <div className="flex flex-wrap gap-4">
              {camOn ? (
                <button
                  onClick={stopCam}
                  className="pop press rounded-full bg-berry px-8 py-4 text-lg font-bold text-cream"
                >
                  ⏹ Stop scanning
                </button>
              ) : (
                <button
                  onClick={startCam}
                  className="pop press rounded-full bg-berry px-8 py-4 text-lg font-bold text-cream"
                >
                  🎥 Start scanning
                </button>
              )}
              <button
                onClick={() => fileRef.current?.click()}
                className="pop press rounded-full bg-mint px-8 py-4 text-lg font-bold"
              >
                📤 Upload photo
              </button>
              <button
                onClick={sensor.connected ? sensor.disconnect : sensor.connect}
                className="pop press rounded-full bg-cream px-6 py-4 font-bold"
              >
                🔌 {sensor.connected ? "Disconnect Arduino" : "Connect Arduino"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  void onFile(file);
                }}
              />
            </div>
            <p className="mt-4 font-mono text-xs font-bold text-muted-foreground">
              Arduino: {sensor.connected ? "Connected" : "Disconnected"} · Temperature:{" "}
              {sensor.live && sensor.latest
                ? `${sensor.latest.temperature.toFixed(1)}°C`
                : "Unavailable"}{" "}
              · Humidity:{" "}
              {sensor.live && sensor.latest
                ? `${sensor.latest.humidity.toFixed(1)}%`
                : "Unavailable"}
              {sensor.connected && sensor.stale && " · ⚠️ Data unavailable / outdated"}
            </p>
            {(error || sensor.serialError || (!sensor.supported && serialHint)) && (
              <p role="alert" className="pop mt-6 rounded-2xl bg-berry/15 px-4 py-3 font-semibold">
                {error ||
                  sensor.serialError ||
                  "Use a supported Chromium-based browser and connect the Arduino through USB."}
              </p>
            )}
          </div>

          <div className="relative">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                onFile(e.dataTransfer.files?.[0]);
              }}
              className="rounded-4xl border-4 border-ink bg-ink p-3 shadow-[8px_8px_0_var(--tang)]"
            >
              <div className="relative aspect-square overflow-hidden rounded-2xl bg-mint/10">
                {camOn ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <img
                    src={preview ?? heroImg}
                    alt="Food to identify"
                    width={1024}
                    height={1024}
                    className="h-full w-full object-cover"
                  />
                )}
                {camOn && (
                  <span className="pop absolute left-3 top-3 rounded-full bg-berry px-3 py-1 font-mono text-[11px] font-bold text-cream">
                    ● LIVE{liveBusy ? " · analyzing" : ""}
                  </span>
                )}
                {drag && (
                  <div className="absolute inset-0 grid place-items-center bg-lemon/85 text-2xl font-bold">
                    Drop it here 🍽️
                  </div>
                )}
                {loading && !camOn && (
                  <div className="absolute inset-0 grid place-items-center bg-ink/60">
                    <span className="pop animate-pulse rounded-full bg-lemon px-6 py-3 font-bold">
                      🔍 Analyzing…
                    </span>
                  </div>
                )}
                {!camOn && !preview && !drag && (
                  <div className="absolute inset-x-0 bottom-4 text-center">
                    <span className="pop rounded-full bg-cream px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.15em]">
                      Drag &amp; drop an image
                    </span>
                  </div>
                )}
              </div>
            </div>
            {result?.items?.[0] && (
              <div className="pop absolute -left-4 -top-4 -rotate-6 rounded-2xl bg-sky px-5 py-3 font-bold text-cream">
                {result.items[0].emoji} {result.items[0].name}
              </div>
            )}
            {result?.items?.[1] && (
              <div className="pop absolute -bottom-4 -right-3 rotate-[5deg] rounded-2xl bg-lemon px-5 py-3 font-bold">
                {result.items[1].emoji} {result.items[1].name}
              </div>
            )}
          </div>
        </section>

        {result && (
          <section className="grid gap-6 lg:grid-cols-3">
            <div className="pop-card p-6 shadow-[8px_8px_0_var(--mint)] md:p-8 lg:col-span-2">
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <p className="mb-2 font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Top prediction
                  </p>
                  <h2 className="text-4xl font-bold">
                    {result.emoji} {result.name}
                  </h2>
                  <span className="mt-2 inline-block rounded-full border-2 border-ink bg-mint/20 px-3 py-1 text-sm font-bold">
                    {result.category}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Confidence
                  </p>
                  <p
                    className={`text-5xl font-bold ${result.uncertain ? "text-tang" : "text-mint"}`}
                  >
                    {conf}%
                  </p>
                </div>
              </div>
              <div className="mb-6 h-5 overflow-hidden rounded-full border-2 border-ink bg-ink/10">
                <div
                  className={`h-full ${result.uncertain ? "bg-tang" : "bg-mint"}`}
                  style={{ width: `${conf}%` }}
                />
              </div>
              <p className="mb-6 leading-relaxed text-muted-foreground">{result.info}</p>
              {result.isFood && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ["Calories", result.nutrition?.calories, "bg-lemon/40"],
                    ["Fat", result.nutrition?.fat, "bg-sky/15"],
                    ["Protein", result.nutrition?.protein, "bg-mint/20"],
                    ["Carbs", result.nutrition?.carbohydrates, "bg-berry/10"],
                  ].map(([l, v, bg]) => (
                    <div key={l} className={`rounded-xl border-2 border-ink p-3 text-center ${bg}`}>
                      <p className="text-lg font-bold">{v || "—"}</p>
                      <p className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                        {l}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-6">
              {result.freshness && (
                <div className="pop-card p-6 shadow-[8px_8px_0_var(--lemon)]">
                  <p className="mb-3 font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Freshness
                  </p>
                  <p className="text-xl font-bold">
                    {FRESH[result.freshness.status]?.label ?? "⚪ Cannot determine"}
                  </p>
                  <div className="mt-3 flex justify-between text-sm font-bold">
                    <span>Visual freshness</span>
                    <span>{Math.round(result.freshness.visualScore)}%</span>
                  </div>
                  <div className="mt-1 h-3 overflow-hidden rounded-full bg-ink/10">
                    <div
                      className={`h-full ${FRESH[result.freshness.status]?.bar ?? "bg-ink/40"}`}
                      style={{ width: `${Math.max(3, result.freshness.visualScore)}%` }}
                    />
                  </div>
                  {result.freshness.signs?.length > 0 && (
                    <p className="mt-3 text-sm font-semibold">
                      Signs: {result.freshness.signs.join(", ")}
                    </p>
                  )}
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {result.freshness.summary}
                  </p>
                  <p className="mt-2 font-mono text-[11px] font-bold text-muted-foreground">
                    {sensor.live && sensor.latest
                      ? `🌡️ ${sensor.latest.temperature.toFixed(1)}°C · 💧 ${sensor.latest.humidity.toFixed(1)}% — ${result.freshness.environment}`
                      : "Environmental sensor data unavailable."}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {result.safetyDisclaimer}
                  </p>
                </div>
              )}
              {result.alternatives?.length > 0 && (
                <div className="pop-card p-6 shadow-[8px_8px_0_var(--berry)]">
                  <p className="mb-4 font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Other possibilities
                  </p>
                  <div className="space-y-4">
                    {result.alternatives.slice(0, 3).map((a, i) => (
                      <div key={a.name}>
                        <div className="mb-1 flex justify-between text-sm font-bold">
                          <span>{a.name}</span>
                          <span>{Math.round(a.confidence)}%</span>
                        </div>
                        <div className="h-3 overflow-hidden rounded-full bg-ink/10">
                          <div
                            className={`h-full ${altColors[i]}`}
                            style={{ width: `${Math.max(3, a.confidence)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.items?.length > 0 && (
                <div className="pop-card p-6 shadow-[8px_8px_0_var(--tang)]">
                  <p className="mb-4 font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Detected in frame · {result.detectedItemCount}
                  </p>
                  <div className="flex flex-col gap-2">
                    {result.items.map((it, i) => {
                      const [bg, fg] = itemColors[i % itemColors.length]!;
                      return (
                        <div
                          key={it.name + i}
                          className={`flex items-center gap-3 rounded-xl border-2 border-ink px-3 py-2 ${bg}`}
                        >
                          <span className="text-xl">{it.emoji}</span>
                          <span className="text-sm font-bold">{it.name}</span>
                          <span className={`ml-auto font-mono text-xs font-bold ${fg}`}>
                            {Math.round(it.confidence)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(result.uncertain || !result.isFood) && (
                <div className="rounded-4xl border-4 border-ink bg-ink p-6 text-cream shadow-[8px_8px_0_var(--lemon)]">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xl">⚠️</span>
                    <span className="font-bold text-lemon">Uncertainty warning</span>
                  </div>
                  <p className="text-sm leading-relaxed text-cream/80">
                    {result.warning ||
                      "The model isn't sure about this one — try a closer, brighter photo."}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {history.length > 0 && (
          <section className="mt-10">
            <p className="mb-4 font-mono text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
              Recent scans
            </p>
            <div className="flex gap-4 overflow-x-auto pb-3">
              {history.map((h) => (
                <div key={h.id} className="pop w-36 shrink-0 rounded-2xl bg-cream p-2">
                  <img
                    src={h.thumb}
                    alt={h.name}
                    width={96}
                    height={96}
                    loading="lazy"
                    className="aspect-square w-full rounded-xl object-cover"
                  />
                  <p className="mt-2 truncate text-sm font-bold">
                    {h.emoji} {h.name}
                  </p>
                  <p className="font-mono text-[11px] font-bold text-muted-foreground">
                    {Math.round(h.confidence)}%
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="mt-10 flex flex-col items-center justify-between gap-3 border-t-4 border-ink px-8 py-6 text-sm font-medium text-muted-foreground sm:flex-row">
        <span>🍎 FoodVision AI — eat smarter, one scan at a time.</span>
        <span className="font-mono">Results are AI estimates</span>
      </footer>
    </div>
  );
}
