class SoundEffects {
  private ctx: AudioContext | null = null;
  public enabled = true;

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private tone(freq: number, duration: number, type: OscillatorType = 'sine', gainVal = 0.08, delay = 0) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(gainVal, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playCardDraw() {
    this.tone(420, 0.08, 'triangle', 0.06, 0);
    this.tone(560, 0.07, 'sine', 0.05, 0.03);
  }

  playRouteClaim() {
    this.tone(523.25, 0.14, 'triangle', 0.08, 0);
    this.tone(659.25, 0.16, 'triangle', 0.08, 0.08);
    this.tone(783.99, 0.22, 'sine', 0.09, 0.16);
  }

  playDiceRoll(success: boolean) {
    this.tone(240, 0.05, 'square', 0.04, 0);
    this.tone(310, 0.05, 'square', 0.04, 0.06);
    this.tone(280, 0.05, 'square', 0.04, 0.12);
    if (success) {
      this.tone(587.33, 0.18, 'triangle', 0.09, 0.2);
      this.tone(880, 0.25, 'sine', 0.09, 0.3);
    } else {
      this.tone(220, 0.22, 'sawtooth', 0.07, 0.2);
      this.tone(164.81, 0.32, 'sawtooth', 0.07, 0.32);
    }
  }

  playTunnelFlip() {
    this.tone(392, 0.1, 'triangle', 0.07, 0);
    this.tone(440, 0.1, 'triangle', 0.07, 0.1);
    this.tone(493.88, 0.14, 'triangle', 0.07, 0.2);
  }
}

export const soundFx = new SoundEffects();
