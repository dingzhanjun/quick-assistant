// Synthesized two-note chime (no audio file needed). Browsers only allow audio after a user
// gesture, so the AudioContext must be created from a click handler (see createAudio()).
export function createAudio(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
}

export function playChime(ctx: AudioContext) {
  if (ctx.state === "suspended") void ctx.resume();
  const t0 = ctx.currentTime;
  // Played twice so it's noticeable in a busy kitchen.
  [0, 0.7].forEach((offset) =>
    [880, 1318.5].forEach((freq, i) => {
      const start = t0 + offset + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.55);
    }),
  );
}
