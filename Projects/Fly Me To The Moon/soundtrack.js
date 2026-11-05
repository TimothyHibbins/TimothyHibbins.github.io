// The soundtrack: plays on a loop, and follows the simulation's time. While
// time simply passes it plays normally. When time is shifted (scrubbing,
// scrolling, seeking, rewinding) it shifts like a tape - fast and high going
// forwards, backwards audio going back - and then lands where the shifted
// time puts it, as if it had been playing in step with the simulation.
//
// One player lives in the essay page. Every simulation iframe is running at
// once, so each reports its time here and only the visible one is heard.

class SoundtrackPlayer {

    constructor(url) {

        this.url = url;
        this.ctx = null;
        this.master = null;
        this.forward = null;
        this.reversed = null;
        this.duration = 0;
        this.loading = false;
        this.wanted = false;

        this.anchor = null; // where the playing source was when its rate last changed
        this.voice = null; // the current source and its fade gain

        this.lastT = null;
        this.lastCaller = null;
        this.lastMs = 0;
        this.shifting = false;
        this.shiftIdle = 0;
        this.target = 0; // where the song should be, in seconds
        this.silent = false; // held quiet because time has stopped
        this.resumePos = 0; // where the song waits while silent

        // the essay page tells us which simulation is on screen
        this.isActive = () => true;

    }

    // call from a user gesture: browsers only allow audio after one
    unlock() {

        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.ctx = new AudioCtx();
            this.master = this.ctx.createGain();
            this.master.gain.value = 0.6;
            this.master.connect(this.ctx.destination);
        }

        if (this.ctx.state !== 'running') {
            this.ctx.resume();
        }

        this.wanted = true;

        if (!this.forward && !this.loading) {
            this.load();
        } else if (this.forward && !this.voice && !this.silent) {
            this.startVoice('fwd', 0, 1);
        }

    }

    async load() {

        this.loading = true;

        try {
            const response = await fetch(this.url);
            const data = await response.arrayBuffer();
            this.forward = await new Promise((resolve, reject) => {
                this.ctx.decodeAudioData(data, resolve, reject);
            });
        } catch (err) {
            console.warn('soundtrack failed to load', err);
            this.loading = false;
            return;
        }

        this.duration = this.forward.duration;
        this.buildReversed();
        this.loading = false;

        if (this.wanted && !this.voice && !this.silent) {
            this.startVoice('fwd', 0, 1);
        }

    }

    // a mono, half-rate copy played forwards sounds like the song backwards,
    // for a fraction of the memory a full copy would take
    buildReversed() {

        const src = this.forward;
        const rate = 22050;
        const n = Math.ceil(this.duration * rate);
        this.reversed = this.ctx.createBuffer(1, n, rate);

        const out = this.reversed.getChannelData(0);
        const channels = [];
        for (let c = 0; c < src.numberOfChannels; c++) {
            channels.push(src.getChannelData(c));
        }

        const length = src.length;
        const ratio = src.sampleRate / rate;

        for (let i = 0; i < n; i++) {
            const at = Math.min(length - 1, Math.floor((n - 1 - i) * ratio));
            let sum = 0;
            for (const data of channels) {
                sum += data[at];
            }
            out[i] = sum / channels.length;
        }

    }

    wrap(t) {
        return this.duration > 0 ? ((t % this.duration) + this.duration) % this.duration : 0;
    }

    // the song position now
    position() {

        if (this.silent) return this.resumePos;
        const a = this.anchor;
        if (!a) return 0;
        return this.wrap(a.pos + a.dir * (this.ctx.currentTime - a.t) * a.rate);

    }

    startVoice(mode, pos, rate) {

        const ctx = this.ctx;
        const now = ctx.currentTime;
        const fade = 0.06;
        const buffer = mode === 'fwd' ? this.forward : this.reversed;
        if (!buffer) return;

        if (this.voice) {
            const old = this.voice;
            old.gain.gain.cancelScheduledValues(now);
            old.gain.gain.setValueAtTime(old.gain.gain.value, now);
            old.gain.gain.linearRampToValueAtTime(0, now + fade);
            old.source.stop(now + fade + 0.02);
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = rate;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(1, now + fade);
        source.connect(gain);
        gain.connect(this.master);

        // the reversed copy runs from the end of the song
        const offset = mode === 'fwd' ? pos : this.duration - pos;
        source.start(0, this.wrap(offset) % buffer.duration);

        this.voice = { source, gain, mode };
        this.anchor = { t: now, pos, rate, dir: mode === 'fwd' ? 1 : -1 };
        this.silent = false;

    }

    // time has stopped (paused, crashed): fade out and keep the place
    silence() {

        if (this.silent || !this.voice) return;

        const now = this.ctx.currentTime;
        const old = this.voice;
        this.resumePos = this.position();
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setValueAtTime(old.gain.gain.value, now);
        old.gain.gain.linearRampToValueAtTime(0, now + 0.15);
        old.source.stop(now + 0.17);
        this.voice = null;
        this.silent = true;

    }

    setRate(rate) {

        if (!this.voice) return;
        const now = this.ctx.currentTime;
        const pos = this.position();
        const dir = this.anchor.dir;

        this.voice.source.playbackRate.setTargetAtTime(rate, now, 0.05);
        this.anchor = { t: now, pos, rate, dir };

    }

    // Called by the simulation each frame with its time T (in frames), its
    // window, and whether time is stopped (paused or crashed). Only the
    // simulation on screen steers the music.
    update(caller, T, stopped = false) {

        if (!this.ctx || !(this.voice || this.silent) || !this.isActive(caller)) {
            return;
        }

        const nowMs = performance.now();
        const real = (nowMs - this.lastMs) / 1000;
        this.lastMs = nowMs;

        // a different simulation, or the page just woke up: nothing to compare
        if (caller !== this.lastCaller || this.lastT === null || real > 0.5) {
            this.lastCaller = caller;
            this.lastT = T;
            return;
        }

        const dT = T - this.lastT;
        this.lastT = T;

        if (Math.abs(dT) > 1) {

            const speed = Math.min(4, Math.max(1.5, Math.abs(dT) / 60 / Math.max(real, 1 / 120)));
            const mode = dT > 0 ? 'fwd' : 'rev';

            // this draw's one normal frame passes in real time, the rest is a shift
            if (!this.shifting) {
                this.target = this.wrap(this.position() + (dT - 1) / 60);
                this.startVoice(mode, this.position(), speed);
            } else {
                this.target = this.wrap(this.target + real + (dT - 1) / 60);
                if (this.voice.mode !== mode) {
                    this.startVoice(mode, this.position(), speed);
                } else {
                    this.setRate(speed);
                }
            }

            this.shiftIdle = 0;
            this.shifting = true;
            return;

        }

        if (!this.shifting) {
            if (stopped) {
                this.silence();
            } else if (this.silent) {
                this.startVoice('fwd', this.resumePos, 1);
            }
            return;
        }

        // the shift is over once time has been steady for a moment: land
        // where the shifted time puts the song
        this.target = this.wrap(this.target + (stopped ? 0 : real));
        this.shiftIdle += real;

        if (this.shiftIdle >= 0.12) {
            this.shifting = false;
            this.startVoice('fwd', this.target, 1);
            if (stopped) this.silence();
        }

    }

}

// only the essay page (the top window) hosts the player
if (window.parent === window) {
    window.soundtrackPlayer = window.soundtrackPlayer || new SoundtrackPlayer('soundtrack.mp3');
}
