"use client";

/**
 * Notification sounds, synthesised with the Web Audio API — no audio files to
 * load, nothing fetched.
 *
 *   deposit   a bright rising "cha-ching" for money arriving
 *   activity  a soft two-note tick for any other transaction
 *   failure   a low, short tone for something that didn't go through
 *
 * Browsers only allow sound after the person has interacted with the page, so
 * the audio context is created on the first tap or key press
 * (unlockNotificationSound) and reused. Sounds can be switched off from the
 * notification bell; the choice is remembered in this browser.
 */

export type NotifySound = "deposit" | "activity" | "failure";

const PREF_KEY = "payai_notification_sound";
const CHANGE_EVENT = "payai:notification-sound";

let ctx: AudioContext | null = null;
let unlockBound = false;

/** Sounds are on unless this browser turned them off. */
export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* private mode — the choice lasts for this page only */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onSoundPreferenceChange(fn: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Arms sound on the first user gesture. Safe to call many times. */
export function unlockNotificationSound(): void {
  if (typeof window === "undefined" || unlockBound) return;
  unlockBound = true;
  const unlock = () => {
    const c = audioContext();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
}

/** Starts audio from inside a tap (e.g. the sound switch) and plays `kind`
 *  once it is running — the way to give an immediate preview. */
export function previewNotificationSound(kind: NotifySound): void {
  const c = audioContext();
  if (!c) return;
  if (c.state === "running") { playNotificationSound(kind); return; }
  void c.resume().then(() => playNotificationSound(kind)).catch(() => {});
}

/** One soft bell-like note: sine with a quick attack and exponential decay. */
function note(c: AudioContext, freq: number, start: number, length: number, gain: number, type: OscillatorType = "sine"): void {
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(amp).connect(c.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** Plays a notification sound if sounds are on and the browser allows it.
 *  Never throws — a sound is a nicety, not part of the notification. */
export function playNotificationSound(kind: NotifySound): void {
  if (!soundEnabled()) return;
  const c = audioContext();
  if (!c || c.state !== "running") return;
  try {
    const t = c.currentTime + 0.01;
    if (kind === "deposit") {
      // A rising major arpeggio with a bright top — the "cha-ching".
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(c, f, t + i * 0.075, 0.5, 0.16));
      note(c, 2093, t + 0.3, 0.6, 0.05, "triangle");
    } else if (kind === "activity") {
      note(c, 880, t, 0.22, 0.09);
      note(c, 1318.5, t + 0.08, 0.3, 0.07);
    } else {
      note(c, 311.13, t, 0.28, 0.1, "triangle");
      note(c, 233.08, t + 0.12, 0.38, 0.09, "triangle");
    }
  } catch {
    /* ignore */
  }
}
