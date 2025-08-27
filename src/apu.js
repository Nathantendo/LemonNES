// apu.js
// Cycle-based NES APU with frame sequencer, envelopes, sweep, length/linear counters.
// Includes a lightweight WebAudio sink (can be disabled).

/* ======================
   Constants / Tables
   ====================== */

const NTSC_CPU_HZ = 1789773; // CPU master clock (NTSC)
const DEFAULT_SAMPLE_RATE = 48000; // Audio output sample rate

// Frame sequencer step intervals (CPU cycles) — approximate NTSC values.
// Quarter frame every ~7457 cycles, half frame every ~14914 cycles.
const STEP_INTERVAL = 7457;         // quarter-frame tick
const HALF_STEP_INTERVAL = 14914;   // half-frame tick

// Length counter table (index from writes to $4003/$4007/$400B/$400F upper 5 bits)
const LENGTH_TABLE = [
  10, 254, 20,  2, 40,  4, 80,  6,
  160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22,
  192,24, 72, 26, 16, 28, 32, 30
];

// Noise period table (NTSC) in CPU cycles
const NOISE_PERIODS = [
   4,   8,  16,  32,  64,  96, 128, 160,
 202, 254, 380, 508, 762, 1016, 2034, 4068
];

// DMC rates (NTSC) in CPU cycles (stubbed channel uses it for timing)
const DMC_RATES = [
  428, 380, 340, 320, 286, 254, 226, 214,
  190, 160, 142, 128, 106,  85,  72,  54
];

// Helper
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ======================
   Envelope (shared by pulse/noise)
   ====================== */
class Envelope {
  constructor() {
    this.loop = false;          // if true, decay loops (a.k.a. length-halt)
    this.constantVolume = false;
    this.volume = 0;            // 0..15 (also "envelope period")
    this.startFlag = false;

    this.decayLevel = 0;        // 0..15
    this.divider = 0;
  }

  write(n) {
    this.loop = !!(n & 0x20);               // also acts as length counter halt
    this.constantVolume = !!(n & 0x10);
    this.volume = n & 0x0F;
  }

  restart() {
    this.startFlag = true;
  }

  quarterFrameTick() {
    if (this.startFlag) {
      this.startFlag = false;
      this.decayLevel = 15;
      this.divider = this.volume;
    } else {
      if (this.divider === 0) {
        this.divider = this.volume;
        if (this.decayLevel > 0) {
          this.decayLevel--;
        } else if (this.loop) {
          this.decayLevel = 15;
        }
      } else {
        this.divider--;
      }
    }
  }

  output() {
    return this.constantVolume ? this.volume : this.decayLevel;
  }
}

/* ======================
   Sweep (Pulse only)
   ====================== */
class Sweep {
  constructor(pulse) {
    this.pulse = pulse;
    this.enabled = false;
    this.period = 0;
    this.negate = false;
    this.shift = 0;

    this.counter = 0;
    this.reload = false;
    this.mute = false;
  }

  write(n) {
    this.enabled = !!(n & 0x80);
    this.period = (n >> 4) & 0x07;
    this.negate = !!(n & 0x08);
    this.shift = n & 0x07;
    this.reload = true;
  }

  targetPeriod() {
    const p = this.pulse.timer;
    const change = p >> this.shift;
    if (this.shift === 0) return p; // no change
    // Channel 1 has extra -1 on negate (hardware quirk) — emulate both the same for simplicity
    let target = this.negate ? (p - change) : (p + change);
    return target;
  }

  halfFrameTick() {
    if (!this.enabled || this.shift === 0) {
      if (this.reload) this.counter = this.period;
      this.reload = false;
      return;
    }

    if (this.counter === 0) {
      this.counter = this.period;
      const t = this.targetPeriod();
      // Hardware mutes if target >= 0x800 or current timer < 8
      if (t < 0x800 && this.pulse.timer >= 8) {
        this.pulse.timer = t;
      }
    } else {
      this.counter--;
    }

    if (this.reload) {
      this.counter = this.period;
      this.reload = false;
    }
  }
}

/* ======================
   Length Counter
   ====================== */
class LengthCounter {
  constructor() {
    this.value = 0;
    this.halt = false; // from envelope.loop bit
  }
  set(index5bit) {
    this.value = LENGTH_TABLE[index5bit & 0x1F] || 0;
  }
  halfFrameTick() {
    if (!this.halt && this.value > 0) this.value--;
  }
  isZero() { return this.value === 0; }
}

/* ======================
   Pulse Channel (x2)
   ====================== */
class Pulse {
  constructor(channelIndex) {
    this.ch = channelIndex; // 0 or 1
    this.enabled = false;

    this.envelope = new Envelope();
    this.length = new LengthCounter();
    this.sweep = new Sweep(this);

    // Duty: 0..3 => 12.5%, 25%, 50%, 75%
    this.duty = 0;
    this.dutyStep = 0;

    // Timer (period): 11-bit
    this.timer = 0;
    this.timerCounter = 0;

    this.length.halt = false; // mirrors envelope.loop
  }

  write0(n) {
    this.envelope.write(n);
    this.length.halt = this.envelope.loop;
    this.duty = (n >> 6) & 0x03;
  }
  write1(n) { this.sweep.write(n); }
  write2(n) { this.timer = (this.timer & 0x700) | n; }
  write3(n) {
    this.timer = (this.timer & 0x0FF) | ((n & 0x07) << 8);
    if (this.enabled) this.length.set((n >> 3) & 0x1F);
    this.envelope.restart();
    this.dutyStep = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.length.value = 0;
  }

  quarterFrameTick() {
    this.envelope.quarterFrameTick();
  }

  halfFrameTick() {
    this.length.halfFrameTick();
    this.sweep.halfFrameTick();
  }

  // Clock at CPU cycle granularity
  clock() {
    if (this.timer < 8) return; // hardware mute
    if (this.timerCounter === 0) {
      this.timerCounter = this.timer;
      this.dutyStep = (this.dutyStep + 1) & 7;
    } else {
      this.timerCounter--;
    }
  }

  output() {
    if (!this.enabled || this.length.isZero() || this.timer < 8 || this.sweep.mute) return 0;

    // NES duty sequences
    // 12.5%: 00000001
    // 25%:   00000011
    // 50%:   00001111
    // 75%:   11111100
    const DUTY_TABLE = [
      [0,0,0,0,0,0,0,1],
      [0,0,0,0,0,0,1,1],
      [0,0,0,0,1,1,1,1],
      [1,1,1,1,1,1,0,0],
    ];
    const on = DUTY_TABLE[this.duty][this.dutyStep];
    if (!on) return 0;
    return this.envelope.output(); // 0..15
  }
}

/* ======================
   Triangle Channel
   ====================== */
class Triangle {
  constructor() {
    this.enabled = false;
    this.length = new LengthCounter();

    // Linear counter
    this.control = false; // also length halt
    this.linearReloadValue = 0;
    this.linearCounter = 0;
    this.reloadFlag = false;

    // Timer
    this.timer = 0;
    this.timerCounter = 0;

    this.seqStep = 0; // 0..31
  }

  write0(n) {
    this.control = !!(n & 0x80);
    this.length.halt = this.control; // tie to length halt bit
    this.linearReloadValue = n & 0x7F;
  }
  write2(n) { this.timer = (this.timer & 0x700) | n; }
  write3(n) {
    this.timer = (this.timer & 0x0FF) | ((n & 0x07) << 8);
    if (this.enabled) this.length.set((n >> 3) & 0x1F);
    this.reloadFlag = true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.length.value = 0;
  }

  quarterFrameTick() {
    if (this.reloadFlag) {
      this.linearCounter = this.linearReloadValue;
    } else if (this.linearCounter > 0) {
      this.linearCounter--;
    }
    if (!this.control) this.reloadFlag = false;
  }

  halfFrameTick() {
    this.length.halfFrameTick();
  }

  clock() {
    if (this.timerCounter === 0) {
      this.timerCounter = this.timer;
      if (!this.length.isZero() && this.linearCounter > 0) {
        this.seqStep = (this.seqStep + 1) & 31;
      }
    } else {
      this.timerCounter--;
    }
  }

  output() {
    if (!this.enabled || this.length.isZero() || this.linearCounter === 0 || this.timer < 2) return 0;
    // 32-step triangle table (0..15..0)
    const TRI_TABLE = [
      15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,
       0, 1, 2, 3, 4, 5,6,7,8,9,10,11,12,13,14,15
    ];
    return TRI_TABLE[this.seqStep];
  }
}

/* ======================
   Noise Channel
   ====================== */
class Noise {
  constructor() {
    this.enabled = false;

    this.envelope = new Envelope();
    this.length = new LengthCounter();

    this.mode = 0;  // 0 = long, 1 = short LFSR tap
    this.periodIndex = 0;

    this.timerCounter = 0;
    this.lfsr = 1;  // 15-bit LFSR; initial nonzero
  }

  write0(n) {
    this.envelope.write(n);
    this.length.halt = this.envelope.loop;
  }
  write2(n) {
    this.mode = (n & 0x80) ? 1 : 0;
    this.periodIndex = n & 0x0F;
  }
  write3(n) {
    if (this.enabled) this.length.set((n >> 3) & 0x1F);
    this.envelope.restart();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.length.value = 0;
  }

  quarterFrameTick() {
    this.envelope.quarterFrameTick();
  }

  halfFrameTick() {
    this.length.halfFrameTick();
  }

  clock() {
    if (this.timerCounter === 0) {
      this.timerCounter = NOISE_PERIODS[this.periodIndex] || 4;
      // Feedback bit taps: mode 0 => bit 1; mode 1 => bit 6
      const bit0 = this.lfsr & 1;
      const tap = this.mode ? ((this.lfsr >> 6) & 1) : ((this.lfsr >> 1) & 1);
      const feedback = bit0 ^ tap;
      this.lfsr = (this.lfsr >> 1) | (feedback << 14);
    } else {
      this.timerCounter--;
    }
  }

  output() {
    if (!this.enabled || this.length.isZero() || (this.lfsr & 1)) return 0; // bit0=1 => output 0
    return this.envelope.output();
  }
}

/* ======================
   DMC (minimal stub)
   ====================== */
class DMC {
  constructor(readCpuByte) {
    this.enabled = false;
    this.irqEnabled = false;
    this.loop = false;

    this.rateIndex = 0;
    this.timer = 0;
    this.timerCounter = 0;

    // Sample memory
    this.sampleAddr = 0xC000;
    this.sampleLen = 1;
    this.bytesRemaining = 0;
    this.currentAddr = 0;

    // Output unit
    this.outputLevel = 0; // 0..127 (blended in mixer)
    this.shiftReg = 0;
    this.bitsRemaining = 0;
    this.buffer = null;   // holds next byte
    this.bufferEmpty = true;

    this.readCpu = readCpuByte || (() => 0); // you can pass a cpu read callback
  }

  write0(n) {
    this.irqEnabled = !!(n & 0x80);
    this.loop = !!(n & 0x40);
    this.rateIndex = n & 0x0F;
    this.timer = DMC_RATES[this.rateIndex] || 428;
  }
  write1(n) {
    this.outputLevel = n & 0x7F;
  }
  write2(n) {
    this.sampleAddr = 0xC000 + ((n & 0xFF) << 6);
  }
  write3(n) {
    this.sampleLen = ((n & 0xFF) << 4) + 1;
  }

  setEnabled(on) {
    const was = this.enabled;
    this.enabled = !!on;
    if (!was && this.enabled) {
      this.currentAddr = this.sampleAddr;
      this.bytesRemaining = this.sampleLen;
    } else if (!this.enabled) {
      this.bytesRemaining = 0;
    }
  }

  // VERY simplified DMC timing; plays steady tone-ish, enough to keep mixer stable.
  clock() {
    if (!this.enabled) return;
    if (this.timerCounter === 0) {
      this.timerCounter = this.timer;

      if (this.bitsRemaining === 0) {
        if (this.bufferEmpty && this.bytesRemaining > 0) {
          this.buffer = this.readCpu(this.currentAddr & 0xFFFF);
          this.bufferEmpty = false;
          this.currentAddr = (this.currentAddr + 1) & 0xFFFF;
          this.bytesRemaining--;
          if (this.bytesRemaining === 0 && this.loop) {
            this.currentAddr = this.sampleAddr;
            this.bytesRemaining = this.sampleLen;
          }
        }
        if (!this.bufferEmpty) {
          this.shiftReg = this.buffer;
          this.bufferEmpty = true;
          this.bitsRemaining = 8;
        }
      } else {
        // Output unit: 1 => +2, 0 => -2
        if (this.shiftReg & 1) {
          if (this.outputLevel <= 125) this.outputLevel += 2;
        } else {
          if (this.outputLevel >= 2) this.outputLevel -= 2;
        }
        this.shiftReg >>= 1;
        this.bitsRemaining--;
      }
    } else {
      this.timerCounter--;
    }
  }

  output() {
    return this.outputLevel; // 0..127
  }
}

/* ======================
   APU Mixer + Frame Sequencer
   ====================== */
export default class APU {
  constructor({ sampleRate = DEFAULT_SAMPLE_RATE, cpuRead = null, useAudio = true } = {}) {
    // Channels
    this.pulse1 = new Pulse(0);
    this.pulse2 = new Pulse(1);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new DMC(cpuRead);

    // Frame sequencer (we implement a 4-step mode without IRQ for simplicity)
    this.frameCounter = 0;
    this.fcCycles = 0; // cycles accumulated since last quarter-frame
    this.mode5 = false; // if true, 5-step (we still run quarter/half without IRQs)
    this.irqInhibit = true; // we don't generate IRQs in this simplified core

    // Audio / resampling
    this.cpuCycles = 0;
    this.sampleRate = sampleRate;
    this.samplePeriod = NTSC_CPU_HZ / this.sampleRate;
    this.sampleTimer = 0;

    // Master volume
    this.master = 0.3;

    // Optional WebAudio sink (simple ring-buffer -> ScriptProcessor)
    this.audioEnabled = false;
    if (useAudio && (typeof window !== "undefined")) {
      this._initWebAudio(sampleRate);
    }
  }

  /* -------- Bus I/O: $4000–$4017 -------- */
  write(addr, val) {
    val &= 0xFF;
    switch (addr) {
      // Pulse 1
      case 0x4000: this.pulse1.write0(val); break;
      case 0x4001: this.pulse1.write1(val); break;
      case 0x4002: this.pulse1.write2(val); break;
      case 0x4003: this.pulse1.write3(val); break;
      // Pulse 2
      case 0x4004: this.pulse2.write0(val); break;
      case 0x4005: this.pulse2.write1(val); break;
      case 0x4006: this.pulse2.write2(val); break;
      case 0x4007: this.pulse2.write3(val); break;
      // Triangle
      case 0x4008: this.triangle.write0(val); break;
      case 0x400A: this.triangle.write2(val); break;
      case 0x400B: this.triangle.write3(val); break;
      // Noise
      case 0x400C: this.noise.write0(val); break;
      case 0x400E: this.noise.write2(val); break;
      case 0x400F: this.noise.write3(val); break;
      // DMC
      case 0x4010: this.dmc.write0(val); break;
      case 0x4011: this.dmc.write1(val); break;
      case 0x4012: this.dmc.write2(val); break;
      case 0x4013: this.dmc.write3(val); break;

      case 0x4015: // Channel enables
        this.pulse1.setEnabled(val & 0x01);
        this.pulse2.setEnabled(val & 0x02);
        this.triangle.setEnabled(val & 0x04);
        this.noise.setEnabled(val & 0x08);
        this.dmc.setEnabled(val & 0x10);
        break;

      case 0x4017: { // Frame counter
        this.mode5 = !!(val & 0x80);
        this.irqInhibit = !!(val & 0x40);
        // Immediately clock a quarter/half on write in 5-step mode (hardware quirk),
        // we emulate by resetting counters.
        this.fcCycles = 0;
        this.frameCounter = 0;
        break;
      }

      default: break;
    }
  }

  read(addr) {
    if (addr === 0x4015) {
      // Return channel status (simplified; no IRQ flags)
      return (this.pulse1.length.isZero() ? 0 : 1) |
             (this.pulse2.length.isZero() ? 0 : 2) |
             (this.triangle.length.isZero() ? 0 : 4) |
             (this.noise.length.isZero() ? 0 : 8) |
             (this.dmc.enabled ? 16 : 0);
    }
    return 0;
  }

  /* -------- Main stepping -------- */
  // Call with the number of CPU cycles you just executed.
  step(cycles) {
    for (let i = 0; i < cycles; i++) {
      // Tick channel timers once per CPU cycle
      this.pulse1.clock();
      this.pulse2.clock();
      this.triangle.clock();
      this.noise.clock();
      this.dmc.clock();

      // Frame sequencer timing
      this.fcCycles++;
      let quarter = false, half = false;

      if (this.fcCycles === STEP_INTERVAL) {
        quarter = true;
      } else if (this.fcCycles === HALF_STEP_INTERVAL) {
        quarter = true; half = true;
      } else if (this.fcCycles === (STEP_INTERVAL * 3)) {
        quarter = true;
      } else if (this.fcCycles === (HALF_STEP_INTERVAL * 2)) {
        // end of 4-step sequence (~29829 cycles)
        quarter = true; half = true;
        this.fcCycles = 0;
      }

      if (quarter) {
        this.pulse1.quarterFrameTick();
        this.pulse2.quarterFrameTick();
        this.triangle.quarterFrameTick();
        this.noise.quarterFrameTick();
      }
      if (half) {
        this.pulse1.halfFrameTick();
        this.pulse2.halfFrameTick();
        this.triangle.halfFrameTick();
        this.noise.halfFrameTick();
      }

      // Resampling: generate audio sample at output rate
      this.sampleTimer += 1;
      if (this.sampleTimer >= this.samplePeriod) {
        this.sampleTimer -= this.samplePeriod;
        const s = this.mixSample();
        if (this.audioEnabled) this._pushSample(s);
        if (this.onSample) this.onSample(s); // optional callback
      }
    }
  }

  /* -------- Mixer -------- */
  // Based on common non-linear NES mixer approximations
  mixSample() {
    const p1 = this.pulse1.output();
    const p2 = this.pulse2.output();
    const tri = this.triangle.output();
    const noi = this.noise.output();
    const dmc = this.dmc.output();

    let pulseTerm = 0;
    if (p1 || p2) pulseTerm = 95.88 / ((8128 / (p1 + p2)) + 100);

    let tndTerm = 0;
    const tnd = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    if (tnd) tndTerm = 159.79 / ((1 / tnd) + 100);

    const mixed = (pulseTerm + tndTerm) * this.master; // 0..~1
    return mixed * 2 - 1; // convert to -1..+1 for WebAudio
  }

  setVolume(v) { this.master = clamp01(v); }

  /* -------- Optional WebAudio sink -------- */
  _initWebAudio(sampleRate) {
    try {
      const ACtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new ACtx({ sampleRate });
      this.sampleRate = this.ctx.sampleRate;
      this.samplePeriod = NTSC_CPU_HZ / this.sampleRate;

      // ScriptProcessorNode (deprecated but widely supported)
      const BUFFER_SIZE = 2048;
      this.proc = this.ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
      this.proc.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) {
          out[i] = this._dequeueSample();
        }
      };
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.proc.connect(this.gain);
      this.gain.connect(this.ctx.destination);

      // ring buffer for samples
      this._rb = new Float32Array(BUFFER_SIZE * 8);
      this._rbW = 0; this._rbR = 0;

      this.audioEnabled = true;
      // Autoresume on user gesture elsewhere if needed
    } catch {
      this.audioEnabled = false;
    }
  }

  _pushSample(s) {
    const next = (this._rbW + 1) % this._rb.length;
    if (next !== this._rbR) { // avoid overrun
      this._rb[this._rbW] = s;
      this._rbW = next;
    }
  }
  _dequeueSample() {
    if (this._rbR === this._rbW) return 0;
    const s = this._rb[this._rbR];
    this._rbR = (this._rbR + 1) % this._rb.length;
    return s;
    }

  // Optional: external sample callback
  onSample = null;
}
