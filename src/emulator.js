// emulator.js

import CPU from './cpu.js';
import PPU from './ppu.js';
import Memory from './memory.js';
import Input from './input.js';

class Emulator {
  constructor(romData) {
    this.memory = new Memory(romData);
    this.cpu = new CPU(this.memory);
    this.ppu = new PPU(this.memory);
    this.input = new Input();

    this.running = false;
    this.frameInterval = 1000 / 60; // 60 FPS
  }

  reset() {
    this.cpu.reset();
    this.ppu.reset();
    this.memory.reset();
    this.running = true;
  }

  stepFrame() {
    let cycles = 0;
    while (cycles < 29780) { // Approximate cycles per frame
      const cpuCycles = this.cpu.step();
      cycles += cpuCycles;
      this.ppu.step(cpuCycles * 3); // PPU runs 3x faster
    }

    this.ppu.renderFrame();
  }

  start() {
    this.reset();
    const loop = () => {
      if (!this.running) return;
      this.stepFrame();
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
  }
}

export default Emulator;
