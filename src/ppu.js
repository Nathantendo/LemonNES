// ppu.js - Expanded NES PPU

class PPU {
    constructor(memory, canvasContext) {
        this.memory = memory;           // Reference to NES memory (CHR-ROM, PRG-ROM, VRAM)
        this.ctx = canvasContext;       // Canvas 2D context for rendering
        this.screenWidth = 256;
        this.screenHeight = 240;

        // PPU registers
        this.ctrl = 0;   // $2000
        this.mask = 0;   // $2001
        this.status = 0; // $2002
        this.oamAddr = 0; // $2003
        this.scrollX = 0; // $2005
        this.scrollY = 0; // $2005
        this.addr = 0;    // $2006
        this.data = 0;    // $2007

        // Internal VRAM (16KB) and OAM (sprites)
        this.vram = new Uint8Array(0x4000);  
        this.oam = new Uint8Array(256);      

        // Frame buffer
        this.frameBuffer = this.ctx.createImageData(this.screenWidth, this.screenHeight);

        // PPU timing
        this.cycle = 0;
        this.scanline = 0;

        // Palette (simple NES colors)
        this.palette = [
            [84, 84, 84], [0, 30, 116], [8, 16, 144], [48, 0, 136],
            [68, 0, 100], [92, 0, 48], [84, 4, 0], [60, 24, 0],
            [32, 42, 0], [8, 58, 0], [0, 64, 0], [0, 60, 0],
            [0, 50, 60], [0, 0, 0], [0, 0, 0], [0, 0, 0]
        ];
    }

    // Read and write registers
    readRegister(addr) {
        switch(addr) {
            case 0x2002: // PPUSTATUS
                const value = this.status;
                this.status &= 0x7F; // Clear vblank flag
                return value;
            case 0x2007: 
                return this.vram[this.addr++];
            default: return 0;
        }
    }

    writeRegister(addr, value) {
        switch(addr) {
            case 0x2000: this.ctrl = value; break;
            case 0x2001: this.mask = value; break;
            case 0x2003: this.oamAddr = value; break;
            case 0x2004: this.oam[this.oamAddr++] = value; break;
            case 0x2005: 
                if (this.scrollX === null) this.scrollX = value;
                else { this.scrollY = value; this.scrollX = null; }
                break;
            case 0x2006: this.addr = (this.addr << 8) | value; break;
            case 0x2007: this.vram[this.addr++] = value; break;
        }
    }

    // Draw a single pixel in the frame buffer
    drawPixel(x, y, color) {
        const idx = (y * this.screenWidth + x) * 4;
        this.frameBuffer.data[idx] = color[0];
        this.frameBuffer.data[idx + 1] = color[1];
        this.frameBuffer.data[idx + 2] = color[2];
        this.frameBuffer.data[idx + 3] = 255;
    }

    // Render background tiles
    renderBackground() {
        const nameTableStart = 0x2000; // Simplified, ignoring mirroring
        for(let tileY = 0; tileY < 30; tileY++) {
            for(let tileX = 0; tileX < 32; tileX++) {
                const tileIndex = this.vram[nameTableStart + tileY * 32 + tileX];
                const patternLow = this.vram[tileIndex * 16];
                const patternHigh = this.vram[tileIndex * 16 + 8];

                for(let row = 0; row < 8; row++) {
                    for(let col = 0; col < 8; col++) {
                        const bit0 = (patternLow >> (7 - col)) & 1;
                        const bit1 = (patternHigh >> (7 - col)) & 1;
                        const color = this.palette[(bit1 << 1) | bit0];
                        const x = tileX * 8 + col;
                        const y = tileY * 8 + row;
                        this.drawPixel(x, y, color);
                    }
                }
            }
        }
    }

    // Render sprites
    renderSprites() {
        for(let i = 0; i < 64; i++) {
            const yPos = this.oam[i * 4];
            const tileIndex = this.oam[i * 4 + 1];
            const attributes = this.oam[i * 4 + 2];
            const xPos = this.oam[i * 4 + 3];

            const patternLow = this.vram[tileIndex * 16];
            const patternHigh = this.vram[tileIndex * 16 + 8];

            for(let row = 0; row < 8; row++) {
                for(let col = 0; col < 8; col++) {
                    const bit0 = (patternLow >> (7 - col)) & 1;
                    const bit1 = (patternHigh >> (7 - col)) & 1;
                    const colorIndex = (bit1 << 1) | bit0;
                    if(colorIndex === 0) continue; // transparent
                    const color = this.palette[colorIndex];
                    this.drawPixel(xPos + col, yPos + row, color);
                }
            }
        }
    }

    // Render full frame
    renderFrame() {
        this.renderBackground();
        this.renderSprites();
        this.ctx.putImageData(this.frameBuffer, 0, 0);
    }

    // PPU step (scanline timing simulation)
    step() {
        this.cycle++;
        if(this.cycle > 340) {
            this.cycle = 0;
            this.scanline++;
            if(this.scanline === 241) {
                this.status |= 0x80; // VBlank
                this.renderFrame();
            }
            if(this.scanline >= 262) {
                this.scanline = 0;
                this.status &= 0x7F; // Clear VBlank
            }
        }
    }
}

export default PPU;
