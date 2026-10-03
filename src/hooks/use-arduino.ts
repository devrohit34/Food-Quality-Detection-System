import { useCallback, useEffect, useRef, useState } from "react";

export type Reading = { temperature: number; humidity: number; timestamp: number };

export const BAUD_RATE = 9600;
export const STALE_AFTER_MS = 15_000;
const HISTORY_MAX = 60;
const SMOOTH_N = 5;
const LINE_RE = /^TEMP:\s*(-?\d+(?:\.\d+)?)\s*,\s*HUM:\s*(\d+(?:\.\d+)?)$/i;

export function parseLine(line: string): { temperature: number; humidity: number } | null {
  const m = line.trim().match(LINE_RE);
  if (!m) return null;
  const temperature = Number(m[1]);
  const humidity = Number(m[2]);
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) return null;
  if (temperature < -40 || temperature > 85 || humidity < 0 || humidity > 100) return null;
  return { temperature, humidity };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useArduino() {
  const [supported, setSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<Reading | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [serialError, setSerialError] = useState<string | null>(null);
  const historyRef = useRef<Reading[]>([]);
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const closedRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "serial" in navigator);
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await readerRef.current?.cancel();
    } catch {
      // The reader may already be closed during disconnect.
    }
    try {
      await closedRef.current;
    } catch {
      // Closing the stream can reject after a device disconnects.
    }
    try {
      await portRef.current?.close();
    } catch {
      // The port may already be closed during disconnect.
    }
    readerRef.current = null;
    portRef.current = null;
    setConnected(false);
  }, []);

  const connect = useCallback(async () => {
    setSerialError(null);
    const serial = (navigator as any).serial;
    if (!serial) {
      setSerialError("Use a supported Chromium-based browser and connect the Arduino through USB.");
      return;
    }
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: BAUD_RATE });
      portRef.current = port;
      setConnected(true);
      const decoder = new TextDecoderStream();
      closedRef.current = port.readable.pipeTo(decoder.writable).catch(() => {});
      const reader = decoder.readable.getReader();
      readerRef.current = reader;
      let buf = "";
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? "";
            if (buf.length > 200) buf = "";
            for (const line of lines) {
              const r = parseLine(line);
              if (!r) continue;
              const reading = { ...r, timestamp: Date.now() };
              historyRef.current = [...historyRef.current, reading].slice(-HISTORY_MAX);
              setLatest(reading);
            }
          }
        } catch {
          setSerialError("Arduino disconnected.");
        } finally {
          reader.releaseLock?.();
          setConnected(false);
        }
      })();
    } catch (e) {
      if ((e as Error)?.name !== "NotFoundError")
        setSerialError("Couldn't open the Arduino port. Is another app using it?");
    }
  }, []);

  useEffect(() => {
    const serial = typeof navigator !== "undefined" ? (navigator as any).serial : null;
    const onDisc = (e: any) => {
      if (e.target === portRef.current || e.port === portRef.current) disconnect();
    };
    serial?.addEventListener?.("disconnect", onDisc);
    const onUnload = () => {
      readerRef.current?.cancel().catch(() => {});
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      serial?.removeEventListener?.("disconnect", onDisc);
      window.removeEventListener("beforeunload", onUnload);
      disconnect();
    };
  }, [disconnect]);

  const stale = !latest || now - latest.timestamp > STALE_AFTER_MS;
  const live = connected && !stale && latest;

  /** Smoothed sensor context for the AI, or null when unavailable/outdated. */
  const getContext = useCallback(() => {
    const h = historyRef.current;
    const last = h[h.length - 1];
    if (!connected || !last || Date.now() - last.timestamp > STALE_AFTER_MS) return null;
    const recent = h.slice(-SMOOTH_N);
    const t = avg(recent.map((r) => r.temperature));
    const hu = avg(recent.map((r) => r.humidity));
    const first = h[0]!;
    const dt = last.temperature - first.temperature;
    const dh = last.humidity - first.humidity;
    const mins = Math.max(1, (last.timestamp - first.timestamp) / 60000);
    return {
      temperature: t,
      humidity: hu,
      avgTemperature: avg(h.map((r) => r.temperature)),
      avgHumidity: avg(h.map((r) => r.humidity)),
      trend: `temperature ${dt >= 0 ? "+" : ""}${dt.toFixed(1)}°C, humidity ${dh >= 0 ? "+" : ""}${dh.toFixed(1)}% over ${mins.toFixed(0)} min`,
      ageSeconds: (Date.now() - last.timestamp) / 1000,
    };
  }, [connected]);

  return {
    supported,
    connected,
    latest,
    stale,
    live: !!live,
    serialError,
    connect,
    disconnect,
    getContext,
  };
}
