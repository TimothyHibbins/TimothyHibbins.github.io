// Cook mode: step through the recipe hands-free (finger snap via microphone,
// buttons or arrow keys), with per-step timers that start as you move on.
(function (global) {
    'use strict';

    const R = global.VEP.renderer;
    const M = global.VEP.model;

    const ALARM_REPEAT_MS = 1600;
    const ALARM_MAX_MS = 60000;

    let svg, getModel, wrap, els;
    const st = { active: false, row: 0, timers: new Map(), tickId: 0, wakeLock: null };
    const mic = { listening: false, stream: null, nodes: [], floor: 0.002, phase: 'idle', peak: 0, blocks: 0, over: 0, refractoryUntil: 0, level: 0, thresh: 0.02, rafId: 0 };
    let audioCtx = null;
    let suppressUntil = 0;
    const chips = new Map();

    function ensureAudio() {
        if (!audioCtx) {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
        }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    // ---------- model helpers ----------
    function findStepById(model, id) {
        for (let r = 0; r < model.timeSteps.length; r++) {
            const step = (model.timeSteps[r].steps || []).find(s => s.id === id);
            if (step) return { step, row: r };
        }
        return null;
    }
    function stepTitle(model, step) {
        const lines = R.buildLines(model);
        if (step.type === 'process-start') {
            const p = model.processes.find(x => x.id === step.processId);
            return (p && p.label) || 'process';
        }
        if (step.type === 'merge') return step.outputName || 'combine';
        if (step.type === 'split') return (step.output && step.output.name) || 'split';
        if (step.type === 'add') { const l = lines.get(step.addedLineId); return `add ${l ? l.name : ''}`.trim(); }
        const l = lines.get(step.lineId);
        return step.text || (l ? l.name : 'step');
    }

    // ---------- row focus ----------
    function activeIds() {
        return new Set(st.timers.keys());
    }
    function apply() {
        const model = getModel();
        if (!st.active) { R.drawRowFocus(model, svg, null); return; }
        R.drawRowFocus(model, svg, st.row, activeIds());
        syncTimerTexts();
    }
    function scrollToRow() {
        const model = getModel();
        const n = model.timeSteps.length;
        if (!n) return;
        const rect = svg.getBoundingClientRect();
        const scale = rect.height / parseFloat(svg.getAttribute('height'));
        const y = R.rowY(model, Math.min(st.row, n - 1)) * scale;
        const wr = wrap.getBoundingClientRect();
        wrap.scrollBy({ top: (rect.top + y) - (wr.top + wr.height * 0.35), behavior: 'smooth' });
    }
    function updateStatus() {
        const n = getModel().timeSteps.length;
        els.status.textContent = st.row >= n ? 'Done' : `Step ${st.row + 1} / ${n}`;
        els.back.disabled = st.row <= 0;
        els.next.disabled = st.row >= n;
    }

    // ---------- stepping ----------
    function startTimersForRow(r) {
        const ts = getModel().timeSteps[r];
        if (!ts) return;
        const now = Date.now();
        (ts.steps || []).forEach(step => {
            if (step.timer > 0) st.timers.set(step.id, { end: now + step.timer * 1000, total: step.timer, state: 'running', ringStart: 0, lastBeep: 0 });
        });
    }
    function next() {
        const n = getModel().timeSteps.length;
        if (!st.active || st.row >= n) return;
        startTimersForRow(st.row);
        st.row++;
        afterMove();
    }
    function back() {
        if (!st.active || st.row <= 0) return;
        st.row--;
        afterMove();
    }
    function afterMove() {
        apply();
        updateStatus();
        renderChips();
        scrollToRow();
    }

    // ---------- timers ----------
    function timerText(id) {
        const t = st.timers.get(id);
        if (!t) {
            const f = findStepById(getModel(), id);
            return f ? M.formatDuration(f.step.timer) : '';
        }
        return M.formatDuration(t.state === 'ringing' ? 0 : (t.end - Date.now()) / 1000);
    }
    function syncTimerTexts() {
        svg.querySelectorAll('[data-timer-text]').forEach(el => {
            const id = el.getAttribute('data-timer-text');
            const t = st.timers.get(id);
            el.textContent = timerText(id);
            el.classList.toggle('is-ringing', !!t && t.state === 'ringing');
        });
    }
    function dismiss(id) {
        st.timers.delete(id);
        apply();
        renderChips();
    }
    function ringingIds() {
        return [...st.timers].filter(([, t]) => t.state === 'ringing').map(([id]) => id);
    }
    function beep() {
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.02;
        for (let i = 0; i < 3; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 988;
            const s = t0 + i * 0.24;
            gain.gain.setValueAtTime(0, s);
            gain.gain.linearRampToValueAtTime(0.4, s + 0.01);
            gain.gain.setValueAtTime(0.4, s + 0.12);
            gain.gain.linearRampToValueAtTime(0, s + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(s);
            osc.stop(s + 0.2);
        }
        // The mic would otherwise hear the alarm as snaps.
        suppressUntil = performance.now() + 900;
    }
    function tick() {
        const model = getModel();
        const now = Date.now();
        let changed = false;
        st.timers.forEach((t, id) => {
            if (!findStepById(model, id)) { st.timers.delete(id); changed = true; return; }
            if (t.state === 'running' && now >= t.end) {
                t.state = 'ringing';
                t.ringStart = now;
                changed = true;
            }
            if (t.state === 'ringing') {
                if (now - t.ringStart > ALARM_MAX_MS) { st.timers.delete(id); changed = true; return; }
                if (now - t.lastBeep >= ALARM_REPEAT_MS) { t.lastBeep = now; beep(); }
            }
        });
        if (changed) apply(); else syncTimerTexts();
        renderChips();
    }
    function renderChips() {
        const model = getModel();
        chips.forEach((chip, id) => { if (!st.timers.has(id)) { chip.el.remove(); chips.delete(id); } });
        st.timers.forEach((t, id) => {
            let chip = chips.get(id);
            if (!chip) {
                const el = document.createElement('div');
                el.className = 'cook-chip';
                const time = document.createElement('span');
                time.className = 'cook-chip-time';
                const name = document.createElement('span');
                name.className = 'cook-chip-name';
                const stop = document.createElement('button');
                stop.textContent = '\u00d7';
                stop.title = 'Dismiss timer';
                stop.addEventListener('click', () => dismiss(id));
                el.append(time, name, stop);
                els.timers.appendChild(el);
                chip = { el, time, name };
                chips.set(id, chip);
                const f = findStepById(model, id);
                name.textContent = f ? stepTitle(model, f.step) : '';
            }
            chip.time.textContent = timerText(id);
            chip.el.classList.toggle('is-ringing', t.state === 'ringing');
        });
    }

    // ---------- finger-snap detection ----------
    // A snap is a very short broadband burst: it must rise above a slowly
    // tracked noise floor, then fall away within ~45ms (speech, music and
    // running water stay loud for longer and are rejected).
    function onSnap() {
        els.meter.classList.add('snap');
        setTimeout(() => els.meter.classList.remove('snap'), 300);
        if (ringingIds().length) ringingIds().forEach(dismiss);
        else next();
    }
    function onAudio(e) {
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const blockMs = data.length / audioCtx.sampleRate * 1000;
        const sens = Number(els.sens.value);
        const ratio = 14 - sens * 1.2;
        const thresh = Math.max(0.02, mic.floor * ratio);
        mic.thresh = thresh;
        mic.level = Math.max(rms, mic.level * 0.97);
        const now = performance.now();
        if (mic.phase === 'idle') {
            if (now < mic.refractoryUntil || now < suppressUntil) return;
            if (rms > thresh) {
                mic.phase = 'candidate';
                mic.peak = rms;
                mic.blocks = 0;
                mic.over = 1;
            } else {
                mic.floor = Math.max(0.0005, mic.floor * 0.998 + rms * 0.002);
            }
            return;
        }
        mic.blocks++;
        mic.peak = Math.max(mic.peak, rms);
        if (rms > thresh * 0.4) mic.over++;
        if (mic.blocks * blockMs < 45) return;
        const isSnap = rms < mic.peak * 0.3 && mic.over * blockMs < 70;
        mic.phase = 'idle';
        mic.refractoryUntil = now + (isSnap ? 450 : 250);
        if (isSnap) setTimeout(onSnap, 0);
    }
    function meterLoop() {
        if (!mic.listening) return;
        els.meterBar.style.width = `${Math.min(100, mic.level / (mic.thresh * 2) * 100)}%`;
        mic.rafId = requestAnimationFrame(meterLoop);
    }
    async function startMic() {
        if (mic.listening) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            els.micMsg.textContent = 'Microphone not available in this browser.';
            return;
        }
        try {
            mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        } catch (err) {
            els.micMsg.textContent = 'Microphone blocked or unavailable.';
            return;
        }
        const ctx = ensureAudio();
        const src = ctx.createMediaStreamSource(mic.stream);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1800;
        const proc = ctx.createScriptProcessor(256, 1, 1);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(hp); hp.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
        proc.onaudioprocess = onAudio;
        mic.nodes = [src, hp, proc, mute];
        mic.listening = true;
        mic.phase = 'idle';
        mic.floor = 0.002;
        els.mic.textContent = 'Listening for snaps \u2013 stop';
        els.mic.classList.add('is-on');
        els.micMsg.textContent = '';
        meterLoop();
    }
    function stopMic() {
        if (!mic.listening) return;
        mic.listening = false;
        cancelAnimationFrame(mic.rafId);
        mic.nodes.forEach(n => { try { n.disconnect(); } catch (err) { /* already gone */ } });
        if (mic.nodes[2]) mic.nodes[2].onaudioprocess = null;
        mic.nodes = [];
        if (mic.stream) mic.stream.getTracks().forEach(t => t.stop());
        mic.stream = null;
        els.mic.textContent = 'Listen for finger snaps';
        els.mic.classList.remove('is-on');
        els.meterBar.style.width = '0';
    }

    // ---------- lifecycle ----------
    function requestWakeLock() {
        if (!navigator.wakeLock) return;
        navigator.wakeLock.request('screen').then(l => { st.wakeLock = l; }).catch(() => { });
    }
    function start() {
        if (st.active) return;
        st.active = true;
        st.row = 0;
        st.timers.clear();
        ensureAudio();
        global.VEP.interact.closePopover();
        svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: false }));
        svg.classList.add('cooking');
        els.bar.hidden = false;
        els.toggle.textContent = 'Exit cooking';
        st.tickId = setInterval(tick, 250);
        requestWakeLock();
        afterMove();
    }
    function stop() {
        if (!st.active) return;
        st.active = false;
        stopMic();
        clearInterval(st.tickId);
        st.timers.clear();
        chips.forEach(c => c.el.remove());
        chips.clear();
        if (st.wakeLock) { st.wakeLock.release().catch(() => { }); st.wakeLock = null; }
        svg.classList.remove('cooking');
        els.bar.hidden = true;
        els.toggle.textContent = 'Cook';
        apply();
        syncTimerTexts();
    }
    function restart() {
        st.row = 0;
        st.timers.clear();
        afterMove();
        apply();
    }

    function init(svgEl, getModelFn) {
        svg = svgEl;
        getModel = getModelFn;
        wrap = document.getElementById('canvasWrap');
        els = {
            toggle: document.getElementById('cookBtn'),
            bar: document.getElementById('cookBar'),
            back: document.getElementById('cookBack'),
            next: document.getElementById('cookNext'),
            restart: document.getElementById('cookRestart'),
            status: document.getElementById('cookStatus'),
            mic: document.getElementById('cookMic'),
            micMsg: document.getElementById('cookMicMsg'),
            meter: document.getElementById('cookMeter'),
            meterBar: document.getElementById('cookMeterBar'),
            sens: document.getElementById('cookSens'),
            timers: document.getElementById('cookTimers')
        };
        svg._vepAfterRender = () => { if (st.active) { apply(); updateStatus(); } };
        els.toggle.addEventListener('click', () => (st.active ? stop() : start()));
        els.next.addEventListener('click', next);
        els.back.addEventListener('click', back);
        els.restart.addEventListener('click', restart);
        els.mic.addEventListener('click', () => (mic.listening ? stopMic() : startMic()));
        document.addEventListener('keydown', e => {
            if (!st.active || e.metaKey || e.ctrlKey || e.altKey) return;
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next(); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); back(); }
        });
        document.addEventListener('visibilitychange', () => { if (st.active && !document.hidden) requestWakeLock(); });
    }

    global.VEP.cook = { init, start, stop, next, back };
})(window);
