/**
 * A stand-in for the microphone in headless Chromium tests, as page-side
 * source text for `page.addInitScript`. `getUserMedia` returns a continuous
 * generated tone, an oscillator into a MediaStream: a 440 Hz sine of
 * amplitude 0.5, whose RMS is 0.5/√2 ≈ 0.354 (−9 dBFS). Levels and mouth
 * movement then never depend on the fake capture device's short beeps, which
 * made the audio tests fail under load.
 *
 * `window.__mic` holds the settings and a record of every call:
 * - `calls`: the constraints of each `getUserMedia` call, as JSON;
 * - `real`: true passes calls to the browser's own `getUserMedia` (the fake
 *   capture device of `--use-fake-device-for-media-stream`);
 * - `amplitude`, `frequency`: of the tone of the next call.
 *
 * Each call gets its own tone and stream, so a released and reopened
 * microphone is a new stream, as with a real device; stopping the track
 * stops its oscillator.
 */
export const GENERATED_MICROPHONE = `(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__generated) return;
  const real = md.getUserMedia.bind(md);
  const mic = { calls: [], real: false, amplitude: 0.5, frequency: 440, ctx: null };
  window.__mic = mic;
  md.getUserMedia = async (constraints) => {
    mic.calls.push(JSON.parse(JSON.stringify(constraints ?? null)));
    if (mic.real || !constraints || !constraints.audio) return real(constraints);
    const ctx = (mic.ctx ??= new AudioContext());
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    osc.frequency.value = mic.frequency;
    const gain = ctx.createGain();
    gain.gain.value = mic.amplitude;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    const track = dest.stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      osc.stop();
      osc.disconnect();
      gain.disconnect();
    };
    return dest.stream;
  };
  md.__generated = true;
})();`;
