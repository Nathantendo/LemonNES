// apu.js — NES APU with accurate frame counter (4/5-step, IRQ), and DMC DMA + IRQ.
// Exposes: write/read for $4000–$4017, step(cpuCycles), cpuIRQ(), setVolume(),
// constructor({ cpuRead, cpuStall, onIRQ, sampleRate, useAudio }).

/* ===== Constants ===== */
const NTSC_CPU_HZ = 1789773;                 // NTSC CPU
const DEFAULT_SAMPLE_RATE = 48000;

// DMC rates in CPU cycles (NTSC)
const DMC_RATES = [
  428, 380, 340, 320, 286, 254, 226, 214,
  190, 160, 142, 128, 106,  85,  72,  54
];

const NOISE_PERIODS = [
   4,   8,  16,  32,  64,  96, 128, 160,
 202, 254, 380, 508, 762, 1016, 2034, 4068
];

const LENGTH_TABLE = [
  10, 254, 20,  2, 40,  4, 80,  6,
 160,  8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22,
 192, 24, 72, 26, 16, 28, 32, 30
];

const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;

/* ===== Shared units ===== */
class Envelope {
  constructor() {
    this.loop = false;
    this.constantVolume = false;
    this.volume = 0;
    this.start = false;
    this.decay = 0;
    this.divider = 0;
  }
  write(n) {
    this.loop = !!(n & 0x20);
    this.constantVolume = !!(n & 0x10);
    this.volume = n & 0x0F;
  }
  restart() { this.start = true; }
  quarter() {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else {
      if (this.divider === 0) {
        this.divider = this.volume;
        if (this.decay > 0) this.decay--;
        else if (this.loop) this.decay = 15;
      } else {
        this.divider--;
      }
    }
  }
  out() {
    return this.constantVolume ? this.volume : this.decay;
  }
}

class LengthCounter {
  constructor() {
    this.value = 0;
    this.halt = false;
  }
  load(index) { this.value = LENGTH_TABLE[index & 0x1F] || 0; }
  half() { if (!this.halt && this.value > 0) this.value--; }
  zero() { return this.value === 0; }
}

/* ===== Pulse (x2) ===== */
class Sweep {
  constructor(pulse, isPulse1) {
    this.pulse = pulse;
    this.isPulse1 = isPulse1;
    this.enabled = false;
    this.period = 0;
    this.negate = false;
    this.shift = 0;
    this.counter = 0;
    this.reload = false;
  }
  write(n) {
    this.enabled = !!(n & 0x80);
    this.period = (n >> 4) & 0x07;
    this.negate = !!(n & 0x08);
    this.shift = n & 0x07;
    this.reload = true;
  }
  target() {
    const p = this.pulse.timer;
    const change = p >> this.shift;
    if (this.shift === 0) return p;
    let t = this.negate ? (p - change) : (p + change);
    if (this.negate && this.isPulse1) t -= 1; // pulse1 quirk
    return t;
  }
  half() {
    if (this.counter === 0) {
      if (this.enabled && this.shift !== 0) {
        const t = this.target();
        if (t < 0x800 && this.pulse.timer >= 8) this.pulse.timer = t;
      }
      this.counter = this.period;
    } else {
      this.counter--;
    }
    if (this.reload) {
      this.counter = this.period;
      this.reload = false;
    }
  }
}

class Pulse {
  constructor(isPulse1) {
    this.enabled = false;
    this.env = new Envelope();
    this.len = new LengthCounter();
    this.sweep = new Sweep(this, isPulse1);
    this.duty = 0;
    this.dutyStep = 0;
    this.timer = 0;
    this.timerCnt = 0;
  }
  write0(n) { this.env.write(n); this.len.halt = this.env.loop; this.duty = (n >> 6) & 3; }
  write1(n) { this.sweep.write(n); }
  write2(n) { this.timer = (this.timer & 0x700) | n; }
  write3(n) {
    this.timer = (this.timer & 0x0FF) | ((n & 7) << 8);
    if (this.enabled) this.len.load((n >> 3) & 0x1F);
    this.env.restart();
    this.dutyStep = 0;
  }
  setEnabled(on) { this.enabled = !!on; if (!this.enabled) this.len.value = 0; }
  quarter() { this.env.quarter(); }
  half() { this.len.half(); this.sweep.half(); }
  clock() {
    if (this.timerCnt === 0) {
      this.timerCnt = this.timer;
      this.dutyStep = (this.dutyStep + 1) & 7;
    } else this.timerCnt--;
  }
  out() {
    if (!this.enabled || this.len.zero() || this.timer < 8) return 0;
    const DUTY = [
      [0,0,0,0,0,0,0,1],
      [0,0,0,0,0,0,1,1],
      [0,0,0,0,1,1,1,1],
      [1,1,1,1,1,1,0,0],
    ];
    const gate = DUTY[this.duty][this.dutyStep];
    return gate ? this.env.out() : 0;
  }
}

/* ===== Triangle ===== */
class Triangle {
  constructor() {
    this.enabled = false;
    this.len = new LengthCounter();
    this.control = false; // ties to len.halt
    this.linearReload = 0;
    this.linear = 0;
    this.reloadFlag = false;
    this.timer = 0;
    this.timerCnt = 0;
    this.step = 0;
  }
  write0(n) { this.control = !!(n & 0x80); this.len.halt = this.control; this.linearReload = n & 0x7F; }
  write2(n) { this.timer = (this.timer & 0x700) | n; }
  write3(n) {
    this.timer = (this.timer & 0x0FF) | ((n & 7) << 8);
    if (this.enabled) this.len.load((n >> 3) & 0x1F);
    this.reloadFlag = true;
  }
  setEnabled(on) { this.enabled = !!on; if (!this.enabled) this.len.value = 0; }
  quarter() {
    if (this.reloadFlag) this.linear = this.linearReload;
    else if (this.linear > 0) this.linear--;
    if (!this.control) this.reloadFlag = false;
  }
  half() { this.len.half(); }
  clock() {
    if (this.timerCnt === 0) {
      this.timerCnt = this.timer;
      if (!this.len.zero() && this.linear > 0) this.step = (this.step + 1) & 31;
    } else this.timerCnt--;
  }
  out() {
    if (!this.enabled || this.len.zero() || this.linear === 0 || this.timer < 2) return 0;
    const TRI = [
      15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,
       0, 1, 2, 3, 4, 5,6,7,8,9,10,11,12,13,14,15
    ];
    return TRI[this.step];
  }
}

/* ===== Noise ===== */
class Noise {
  constructor() {
    this.enabled = false;
    this.env = new Envelope();
    this.len = new LengthCounter();
    this.mode = 0;
    this.periodIdx = 0;
    this.timerCnt = 0;
    this.lfsr = 1;
  }
  write0(n) { this.env.write(n); this.len.halt = this.env.loop; }
  write2(n) { this.mode = (n & 0x80) ? 1 : 0; this.periodIdx = n & 0x0F; }
  write3(n) { if (this.enabled) this.len.load((n >> 3) & 0x1F); this.env.restart(); }
  setEnabled(on) { this.enabled = !!on; if (!this.enabled) this.len.value = 0; }
  quarter() { this.env.quarter(); }
  half() { this.len.half(); }
  clock() {
    if (this.timerCnt === 0) {
      this.timerCnt = NOISE_PERIODS[this.periodIdx] || 4;
      const bit0 = this.lfsr & 1;
      const tap = this.mode ? ((this.lfsr >> 6) & 1) : ((this.lfsr >> 1) & 1);
      const fb = bit0 ^ tap;
      this.lfsr = (this.lfsr >> 1) | (fb << 14);
    } else this.timerCnt--;
  }
  out() {
    if (!this.enabled || this.len.zero() || (this.lfsr & 1)) return 0;
    return this.env.out();
  }
}

/* ===== DMC (DMA, IRQ, correct buffering) ===== */
class DMC {
  constructor(cpuRead, cpuStall) {
    this.enabled = false;
    this.irqEnable = false;
    this.loop = false;
    this.rateIdx = 0;

    this.timer = DMC_RATES[0];
    this.timerCnt = 0;

    // Sample settings
    this.sampleAddr0 = 0xC000;
    this.sampleLen0 = 1;

    // Playback state
    this.currentAddr = 0;
    this.bytesRemaining = 0;

    // Buffering / shifter
    this.sampleBufferEmpty = true;
    this.sampleBuffer = 0;
    this.shiftReg = 0;
    this.bitsRemaining = 0;

    // Output DAC
    this.dac = 0; // 0..127

    // IRQ
    this.irq = false;

    // CPU hooks
    this.cpuRead = cpuRead || (() => 0);
    this.cpuStall = cpuStall || (() => {});
  }

  write0(n) {
    this.irqEnable = !!(n & 0x80);
    if (!this.irqEnable) this.irq = false; // disabling IRQ clears flag
    this.loop = !!(n & 0x40);
    this.rateIdx = n & 0x0F;
    this.timer = DMC_RATES[this.rateIdx] || 428;
  }
  write1(n) { this.dac = n & 0x7F; }
  write2(n) { this.sampleAddr0 = 0xC000 + ((n & 0xFF) << 6); }
  write3(n) { this.sampleLen0 = ((n & 0xFF) << 4) + 1; }

  setEnabled(on) {
    const was = this.enabled;
    this.enabled = !!on;
    if (this.enabled && !was) {
      if (this.bytesRemaining === 0) {
        this.currentAddr = this.sampleAddr0;
        this.bytesRemaining = this.sampleLen0;
      }
    } else if (!this.enabled) {
      this.bytesRemaining = 0;
      this.irq = false;
    }
  }

  // Fetch a byte into sampleBuffer if empty & data remaining (steals 4 CPU cycles)
  refillBufferIfNeeded() {
    if (!this.sampleBufferEmpty || this.bytesRemaining === 0) return;
    // DMC DMA read
    const data = this.cpuRead(this.currentAddr & 0xFFFF) & 0xFF;
    this.cpuStall(4); // DMC steals 4 CPU cycles per fetch (NTSC)
    this.sampleBuffer = data;
    this.sampleBufferEmpty = false;
    this.currentAddr = (this.currentAddr + 1) & 0xFFFF;
    this.bytesRemaining--;
    if (this.bytesRemaining === 0 && this.loop) {
      this.currentAddr = this.sampleAddr0;
      this.bytesRemaining = this.sampleLen0;
    } else if (this.bytesRemaining === 0 && this.irqEnable) {
      this.irq = true;
    }
  }

  clock() {
    // Always try to keep buffer filled
    this.refillBufferIfNeeded();

    if (this.timerCnt === 0) {
      this.timerCnt = this.timer;

      if (this.bitsRemaining === 0) {
        if (!this.sampleBufferEmpty) {
          this.shiftReg = this.sampleBuffer;
          this.sampleBufferEmpty = true;
          this.bitsRemaining = 8;
          // Attempt to fetch next byte ASAP (matches HW behavior closely)
          this.refillBufferIfNeeded();
        } else {
          // silence when no data
        }
      } else {
        // Output unit: if bit1 => +2, else -2
        if (this.shiftReg & 1) {
          if (this.dac <= 125) this.dac += 2;
        } else {
          if (this.dac >= 2) this.dac -= 2;
        }
        this.shiftReg >>= 1;
        this.bitsRemaining--;
      }

    } else {
      this.timerCnt--;
    }
  }

  out() { return this.dac; }

  statusActiveBit() { return (this.bytesRemaining > 0) ? 1 : 0; }
}

/* ===== APU Core ===== */
export default class APU {
  constructor({ cpuRead, cpuStall, onIRQ, sampleRate = DEFAULT_SAMPLE_RATE, useAudio = true } = {}) {
    // Channels
    this.pulse1 = new Pulse(true);
    this.pulse2 = new Pulse(false);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new DMC(cpuRead, cpuStall);

    // IRQ lines
    this.frameIRQ = false; // bit6 in $4015
    this.onIRQ = typeof onIRQ === "function" ? onIRQ : null;

    // Frame counter/sequencer
    this.mode5 = false;    // false=4-step, true=5-step
    this.irqInhibit = true;
    this.seqTime = 0;      // CPU cycles (float to keep .5)
    // Quarter frame base period:
    this.qPeriod = NTSC_CPU_HZ / 240; // ≈ 7457.3875 CPU cycles

    // Audio sampling
    this.master = 0.3;
    this.sampleRate = sampleRate;
    this.samplePeriod = NTSC_CPU_HZ / this.sampleRate;
    this.sampleTimer = 0;

    // Optional WebAudio sink
    this.audioEnabled = false;
    if (useAudio && typeof window !== "undefined") this._initWebAudio(sampleRate);
  }

  /* ==== Bus I/O ==== */
  write(addr, v) {
    v &= 0xFF;
    switch (addr) {
      // Pulse 1
      case 0x4000: this.pulse1.write0(v); break;
      case 0x4001: this.pulse1.write1(v); break;
      case 0x4002: this.pulse1.write2(v); break;
      case 0x4003: this.pulse1.write3(v); break;
      // Pulse 2
      case 0x4004: this.pulse2.write0(v); break;
      case 0x4005: this.pulse2.write1(v); break;
      case 0x4006: this.pulse2.write2(v); break;
      case 0x4007: this.pulse2.write3(v); break;
      // Triangle
      case 0x4008: this.triangle.write0(v); break;
      case 0x400A: this.triangle.write2(v); break;
      case 0x400B: this.triangle.write3(v); break;
      // Noise
      case 0x400C: this.noise.write0(v); break;
      case 0x400E: this.noise.write2(v); break;
      case 0x400F: this.noise.write3(v); break;
      // DMC
      case 0x4010: this.dmc.write0(v); break;
      case 0x4011: this.dmc.write1(v); break;
      case 0x4012: this.dmc.write2(v); break;
      case 0x4013: this.dmc.write3(v); break;

      case 0x4015: { // channel enables
        this.pulse1.setEnabled(v & 1);
        this.pulse2.setEnabled(v & 2);
        this.triangle.setEnabled(v & 4);
        this.noise.setEnabled(v & 8);
        const enableDmc = !!(v & 0x10);
        this.dmc.setEnabled(enableDmc);
        if (!enableDmc) this.dmc.irq = false; // disabling clears DMC IRQ flag
        this._updateIRQLine();
        break;
      }

      case 0x4017: { // Frame counter control
        this.mode5 = !!(v & 0x80);
        this.irqInhibit = !!(v & 0x40);
        if (this.irqInhibit) this.frameIRQ = false; // inhibit clears frame IRQ
        // Reset sequencer time
        this.seqTime = 0;
        // In 5-step mode, immediately clock quarter+half (hardware quirk)
        if (this.mode5) this._clockQuarterHalf();
        this._updateIRQLine();
        break;
      }

      default: break;
    }
  }

  read(addr) {
    if (addr !== 0x4015) return 0;
    const p1 = this.pulse1.len.zero() ? 0 : 1;
    const p2 = this.pulse2.len.zero() ? 0 : 2;
    const tri = this.triangle.len.zero() ? 0 : 4;
    const noi = this.noise.len.zero() ? 0 : 8;
    const dmcActive = this.dmc.statusActiveBit() ? 16 : 0;
    const frameIrqBit = this.frameIRQ ? 0x40 : 0;
    const dmcIrqBit = this.dmc.irq ? 0x80 : 0;
    const val = p1 | p2 | tri | noi | dmcActive | frameIrqBit | dmcIrqBit;
    // Reading $4015 clears IRQ flags
    this.frameIRQ = false;
    this.dmc.irq = false;
    this._updateIRQLine();
    return val;
  }

  /* ==== Step timing ==== */
  step(cycles) {
    for (let i = 0; i < cycles; i++) {
      // Clock channels once per CPU cycle
      this.pulse1.clock();
      this.pulse2.clock();
      this.triangle.clock();
      this.noise.clock();
      this.dmc.clock();

      // Frame sequencer position (float to catch .5 cycle boundaries)
      this.seqTime += 1;

      // Quarter-frame ticks at 1×, 2×, 3×, 4×; half-frame at 2×, 4×.
      const t = this.seqTime;
      // Using thresholds based on qPeriod multiples
      const q1 = this.qPeriod * 1;
      const q2 = this.qPeriod * 2;
      const q3 = this.qPeriod * 3;
      const q4 = this.qPeriod * 4;

      // We tick when crossing each boundary (>=) and then mark so we don't tick twice.
      // Implement using integer "phase": 0..3 for 4-step, 0..3 then wrap for 5-step.
      if (!this._phase) this._phase = 0;

      if (this._phase === 0 && t >= q1) { this._clockQuarter(); this._phase = 1; }
      if (this._phase === 1 && t >= q2) { this._clockQuarterHalf(); this._phase = 2; }
      if (this._phase === 2 && t >= q3) { this._clockQuarter(); this._phase = 3; }
      if (this._phase === 3 && t >= q4) {
        this._clockQuarterHalf();
        // End-of-sequence behavior:
        if (!this.mode5 && !this.irqInhibit) this.frameIRQ = true; // 4-step raises frame IRQ
        this._updateIRQLine();
        // Restart sequence
        this.seqTime -= q4; // keep fractional remainder (if any)
        this._phase = 0;
        // 5-step has no extra tick here (we already did Q+H above)
      }

      // Resample to audio
      this.sampleTimer += 1;
      if (this.sampleTimer >= this.samplePeriod) {
        this.sampleTimer -= this.samplePeriod;
        const s = this._mix();
        if (this.audioEnabled) this._pushSample(s);
        if (this.onSample) this.onSample(s);
      }
    }
  }

  _clockQuarter() {
    this.pulse1.quarter();
    this.pulse2.quarter();
    this.triangle.quarter();
    this.noise.quarter();
  }
  _clockQuarterHalf() {
    this._clockQuarter();
    this.pulse1.half();
    this.pulse2.half();
    this.triangle.half();
    this.noise.half();
  }

  /* ==== Mixer (non-linear approximation) ==== */
  _mix() {
    const p1 = this.pulse1.out();
    const p2 = this.pulse2.out();
    const tri = this.triangle.out();
    const noi = this.noise.out();
    const dmc = this.dmc.out();

    let pulseTerm = 0;
    if (p1 || p2) pulseTerm = 95.88 / ((8128 / (p1 + p2)) + 100);

    let tndTerm = 0;
    const tnd = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    if (tnd) tndTerm = 159.79 / ((1 / tnd) + 100);

    const mixed = (pulseTerm + tndTerm) * this.master;
    return mixed * 2 - 1;
  }

  setVolume(v) { this.master = clamp01(v); }

  /* ==== IRQ line helper ==== */
  _updateIRQLine() {
    const asserted = this.dmc.irq || this.frameIRQ;
    if (this.onIRQ) this.onIRQ(asserted);
  }
  cpuIRQ() { return this.dmc.irq || this.frameIRQ; }

  /* ==== WebAudio sink (optional) ==== */
  _initWebAudio(sampleRate) {
    try {
      const ACtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new ACtx({ sampleRate });
      this.sampleRate = this.ctx.sampleRate;
      this.samplePeriod = NTSC_CPU_HZ / this.sampleRate;

      const BUFFER = 2048;
      this.rb = new Float32Array(BUFFER * 8);
      this.rw = 0; this.rr = 0;

      this.proc = this.ctx.createScriptProcessor(BUFFER, 0, 1);
      this.proc.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) out[i] = this._deq();
      };
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.proc.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.audioEnabled = true;
    } catch {
      this.audioEnabled = false;
    }
  }
  _pushSample(s) {
    const next = (this.rw + 1) % this.rb.length;
    if (next !== this.rr) { this.rb[this.rw] = s; this.rw = next; }
  }
  _deq() {
    if (this.rr === this.rw) return 0;
    const s = this.rb[this.rr];
    this.rr = (this.rr + 1) % this.rb.length;
    return s;
  }

  // Optional external sample callback
  onSample = null;
}
