// <!-- IMPL: Shutter-Breath Nav --> — procedural exhale: working-key = 180Hz warm pulse 800→200 sweep, reauth = dry tape click + wobble; same-origin link shutter via document.startViewTransition + Navigation API fallback
(() => {
  'use strict';
  const RM = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (RM) return; // respect reduced-motion: no transition, no breath

  let ac = null;
  function ctx() {
    if (ac) return ac;
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    return ac;
  }
  function ensureResumed(a) {
    if (!a) return;
    if (a.state === 'suspended') a.resume().catch(()=>{});
  }

  // working-key: 180Hz warm pulse (body) + 800→200Hz sweep (exhale tail), filtered, gain-shaped
  function breathWarm() {
    const a = ctx(); if (!a) return; ensureResumed(a);
    const t0 = a.currentTime;
    const master = a.createGain(); master.gain.setValueAtTime(0, t0);
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t0);
    lp.connect(a.destination); master.connect(lp);

    // 180Hz warm body — gentle triangle, short envelope
    const o1 = a.createOscillator(); o1.type = 'triangle'; o1.frequency.setValueAtTime(180, t0);
    const g1 = a.createGain(); g1.gain.setValueAtTime(0, t0);
    g1.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.001, t0 + 0.42);
    o1.connect(g1); g1.connect(master);

    // 800→200 sweep exhale — sine, exponential fall
    const o2 = a.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(800, t0);
    o2.frequency.exponentialRampToValueAtTime(200, t0 + 0.38);
    const g2 = a.createGain(); g2.gain.setValueAtTime(0, t0);
    g2.gain.linearRampToValueAtTime(0.13, t0 + 0.015);
    g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.44);
    o2.connect(g2); g2.connect(master);

    // master swell
    master.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
    master.gain.exponentialRampToValueAtTime(0.001, t0 + 0.46);

    o1.start(t0); o2.start(t0);
    o1.stop(t0 + 0.48); o2.stop(t0 + 0.48);
  }

  // reauth_needed: dry tape click (ultra-short transient) + low wobble with wow
  function tapeClickWobble() {
    const a = ctx(); if (!a) return; ensureResumed(a);
    const t0 = a.currentTime;
    const master = a.createGain(); master.gain.setValueAtTime(0.22, t0);
    master.gain.exponentialRampToValueAtTime(0.001, t0 + 0.62);
    const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.setValueAtTime(180, t0);
    hp.connect(a.destination); master.connect(hp);

    // dry click — 2ms burst at 2400Hz + high shelf bite
    const click = a.createOscillator(); click.type = 'square'; click.frequency.setValueAtTime(2400, t0);
    const cg = a.createGain(); cg.gain.setValueAtTime(0.42, t0); cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.018);
    click.connect(cg); cg.connect(master);

    // wobble body — 78Hz tone with wow (LFO -> frequency)
    const wob = a.createOscillator(); wob.type = 'sine'; wob.frequency.setValueAtTime(78, t0);
    const wg = a.createGain(); wg.gain.setValueAtTime(0, t0);
    wg.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
    wg.gain.linearRampToValueAtTime(0.10, t0 + 0.22);
    wg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.62);
    // wow LFO 11Hz, depth ~18 cents via detune modulation through GainNode -> frequency AudioParam
    const lfo = a.createOscillator(); lfo.type = 'sine'; lfo.frequency.setValueAtTime(11, t0);
    const lfoGain = a.createGain(); lfoGain.gain.setValueAtTime(14, t0); // Hz deviation
    lfo.connect(lfoGain); lfoGain.connect(wob.frequency);
    wob.connect(wg); wg.connect(master);

    // slight tape hiss bed — filtered noise via short buffer
    try {
      const len = Math.floor(a.sampleRate * 0.18);
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 2) * 0.22;
      const src = a.createBufferSource(); src.buffer = buf;
      const hg = a.createGain(); hg.gain.setValueAtTime(0.06, t0); hg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.20);
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(3200, t0); bp.Q.setValueAtTime(0.9, t0);
      src.connect(bp); bp.connect(hg); hg.connect(master);
      src.start(t0);
    } catch {}

    const stopAt = t0 + 0.66;
    click.start(t0); click.stop(t0 + 0.02);
    wob.start(t0); wob.stop(stopAt);
    lfo.start(t0); lfo.stop(stopAt);
  }

  // arm AudioContext on first user gesture so later fetch breaths are audible without extra click
  let armed = false;
  function arm() {
    if (armed) return; armed = true;
    const a = ctx(); ensureResumed(a);
    // tiny inaudible tick to unlock
    try { if (a) { const o=a.createOscillator(), g=a.createGain(); g.gain.setValueAtTime(0,a.currentTime); o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime+0.01); } } catch {}
  }
  ['pointerdown','keydown','click','touchstart'].forEach(ev =>
    window.addEventListener(ev, arm, { once:true, capture:true, passive:true })
  );

  // hook fetch: inspect same-origin /api/ keys & capabilities & access for working vs reauth_needed
  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const res = await _fetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
      if (!/\/api\/(keys|caps|capabilities|stats|access|board)\b/.test(url)) return res;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return res;
      // clone so body still readable
      const clone = res.clone();
      clone.text().then(txt => {
        if (!txt) return;
        const lower = txt.toLowerCase();
        // reauth_needed anywhere → tape click + wobble, otherwise warm pulse if working hint present
        const isReauth = lower.includes('reauth_needed') || lower.includes('reauth') || lower.includes('"status":"dead"') || lower.includes('"status": "dead"');
        const hasWorking = lower.includes('working') || lower.includes('"status":"working"') || lower.includes('"ok"') || lower.includes('200');
        if (isReauth) tapeClickWobble();
        else if (hasWorking || res.ok) breathWarm(); // default to warm pulse on healthy fetch
      }).catch(()=>{});
    } catch {}
    return res;
  };

  // same-origin link shutter: enrich nav with document.startViewTransition when available
  function isSameOrigin(a) {
    try { const u = new URL(a.href, location.href); return u.origin === location.origin; } catch { return false; }
  }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.getAttribute('href')?.startsWith('#')) return;
    if (!isSameOrigin(a)) return;
    const url = new URL(a.href, location.href);
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // breath on nav intent
    try { breathWarm(); } catch {}
    if (document.startViewTransition) {
      e.preventDefault();
      document.startViewTransition(() => { location.href = a.href; });
    }
    // else let browser do native navigation with @view-transition navigation:auto
  }, { capture: true });

  // Navigation API progressive enhancement (when available, Chrome 102+)
  if (window.navigation) {
    window.navigation.addEventListener('navigate', (e) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (!e.canIntercept || e.hashChange || e.downloadRequest) return;
      const url = new URL(e.destination.url);
      if (url.origin !== location.origin) return;
      try { breathWarm(); } catch {}
      if (document.startViewTransition) {
        e.intercept({
          handler() { return document.startViewTransition(async () => { location.href = url.href; }).finished; }
        });
      }
    });
  }

  // expose for manual triggering / testing (not required but handy for console)
  window.__shutterBreath = { breathWarm, tapeClickWobble, ctx };
})();
