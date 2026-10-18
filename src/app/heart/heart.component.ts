import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  ViewChild,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LOVE_PHRASES, LovePhrase } from '../love-phrases';

interface Point {
  x: number;
  y: number;
}

interface PlacedPhrase {
  text: string;
  language: string;
  // Normalized coordinates in parametric heart space (-17..17) so resizing scales cleanly
  normX: number;
  normY: number;
  // Screen-space bounding box used for collision detection
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  baseFontSizeNorm: number; // Font size relative to heart scale
  rotation: number;         // Radians (-15° to +15°)
  color: string;
  spawnTime: number;
  twinklePhase: number;
  twinkleSpeed: number;
}

interface FloatingParticle {
  x: number;
  y: number;
  size: number;
  speedY: number;
  speedX: number;
  opacity: number;
  color: string;
  isMiniHeart: boolean;
  pulsePhase: number;
}

@Component({
  selector: 'app-heart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './heart.component.html',
  styleUrls: ['./heart.component.scss']
})
export class HeartComponent implements OnInit, OnChanges, OnDestroy {
  @ViewChild('heartCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() started = false;

  // Signals for UI overlay
  public readonly currentLanguage = signal<string>('');
  public readonly currentText = signal<string>('');
  public readonly isHeartFull = signal<boolean>(false);
  public readonly placedCount = signal<number>(0);

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private resizeListener = () => this.handleResize();

  // Canvas dimensions & heart geometry
  private width = 0;
  private height = 0;
  private dpr = 1;
  private centerX = 0;
  private centerY = 0;
  private heartScale = 1;
  private heartPolygon: Point[] = [];

  // Phrase queues & placement state
  private phraseQueue: LovePhrase[] = [];
  private placedPhrases: PlacedPhrase[] = [];
  private particles: FloatingParticle[] = [];

  // Timing controls for accelerating phrase appearance
  private lastSpawnTime = 0;
  private spawnInterval = 210; // Starts slow (~210ms), accelerates down to ~20ms
  private fullTimestamp = 0;
  private consecutiveMisses = 0;

  // Crimson / red / pink palette with slight variations
  private readonly palette = [
    '#ff1744',
    '#ff4d6d',
    '#ff758f',
    '#ff0a54',
    '#ff2a55',
    '#e01e37',
    '#ff5c8a',
    '#ff3366',
    '#ff85a1'
  ];

  ngOnInit(): void {
    this.initCanvas();
    this.initParticles();
    this.resetHeartState();
    window.addEventListener('resize', this.resizeListener);
    this.animationFrameId = requestAnimationFrame((t) => this.renderLoop(t));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['started'] && changes['started'].currentValue === true) {
      this.resetHeartState();
    }
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    window.removeEventListener('resize', this.resizeListener);
  }

  /**
   * Clears the heart and restarts the building animation from the beginning.
   */
  public replay(): void {
    this.resetHeartState();
  }

  /**
   * Initializes canvas context and devicePixelRatio scaling.
   */
  private initCanvas(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;
    this.handleResize();
  }

  /**
   * Updates canvas size and recomputes the parametric heart polygon on resize.
   */
  private handleResize(): void {
    const canvas = this.canvasRef.nativeElement;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    canvas.width = this.width * this.dpr;
    canvas.height = this.height * this.dpr;
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${this.height}px`;

    // Parametric heart spans x in [-16, 16] (32 units) and y in [-17, 12] (~29 units)
    const minDim = Math.min(this.width, this.height * 0.92);
    this.heartScale = (minDim * 0.82) / 32;
    this.centerX = this.width / 2;
    this.centerY = this.height * 0.47;

    this.buildHeartPolygon();

    // Update screen coordinates of any already-placed phrases so responsiveness is seamless
    for (const p of this.placedPhrases) {
      p.x = this.centerX + p.normX * this.heartScale;
      p.y = this.centerY + p.normY * this.heartScale;
      p.fontSize = Math.max(9, p.baseFontSizeNorm * this.heartScale);
      this.ctx.font = `700 ${p.fontSize}px "Noto Sans", sans-serif`;
      const metrics = this.ctx.measureText(p.text);
      p.width = metrics.width;
      p.height = p.fontSize * 1.15;
    }
  }

  /**
   * Generates the heart outline using the exact parametric heart equation:
   * x = 16 sin³(t)
   * y = 13 cos(t) − 5 cos(2t) − 2 cos(3t) − cos(4t)
   */
  private buildHeartPolygon(): void {
    this.heartPolygon = [];
    const steps = 360;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const hx = 16 * Math.pow(Math.sin(t), 3);
      const hy =
        13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t);

      // Center vertically around hy + 2.2, and invert Y for screen coordinates
      const screenX = this.centerX + hx * this.heartScale;
      const screenY = this.centerY - (hy + 2.2) * this.heartScale;
      this.heartPolygon.push({ x: screenX, y: screenY });
    }
  }

  /**
   * Ray-casting Point-in-Polygon test to verify a point is strictly inside the heart.
   */
  private isPointInHeart(px: number, py: number): boolean {
    let inside = false;
    const poly = this.heartPolygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;

      const intersect =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-10) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Resets state and prepares the language queue (all 180 languages first, then random repeats).
   */
  private resetHeartState(): void {
    this.placedPhrases = [];
    this.placedCount.set(0);
    this.isHeartFull.set(false);
    this.currentLanguage.set('');
    this.currentText.set('');
    this.lastSpawnTime = performance.now();
    this.spawnInterval = 210;
    this.consecutiveMisses = 0;

    // Ensure Georgian "მიყვარხარ" appears right away, followed by shuffled remaining languages
    const georgian = LOVE_PHRASES[0];
    const others = this.shuffleArray(LOVE_PHRASES.slice(1));
    this.phraseQueue = [georgian, ...others];
  }

  /**
   * Pulls the next language phrase; once all 180 languages are used, refills in random order.
   */
  private getNextPhrase(): LovePhrase {
    if (this.phraseQueue.length === 0) {
      this.phraseQueue = this.shuffleArray([...LOVE_PHRASES]);
    }
    return this.phraseQueue.shift()!;
  }

  private shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Attempts to place a new phrase inside the heart without overlapping existing phrases.
   */
  private tryPlaceNextPhrase(now: number): boolean {
    const candidatePhrase = this.getNextPhrase();

    // Font size tiers relative to heartScale (Large, Medium, Small, Micro for tight edges)
    const fillProgress = Math.min(1, this.placedPhrases.length / 220);
    const sizeTiersNorm =
      fillProgress < 0.25
        ? [0.95, 0.78, 0.62]
        : fillProgress < 0.6
        ? [0.78, 0.62, 0.48]
        : [0.58, 0.45, 0.35];

    // Pick a random tier first, then fall back to smaller tiers if crowded
    const startTierIdx = Math.floor(Math.random() * sizeTiersNorm.length);
    const orderedTiers = [
      ...sizeTiersNorm.slice(startTierIdx),
      ...sizeTiersNorm.slice(0, startTierIdx),
      0.32
    ];

    // Slight random rotation between -15° and +15°
    const maxAngleRad = (15 * Math.PI) / 180;
    const rotation = (Math.random() * 2 - 1) * maxAngleRad;
    const cosA = Math.cos(rotation);
    const sinA = Math.sin(rotation);

    for (const normSize of orderedTiers) {
      const fontSize = Math.max(9.5, normSize * this.heartScale);
      this.ctx.font = `700 ${fontSize}px "Noto Sans", "Noto Sans Georgian", sans-serif`;
      const textWidth = this.ctx.measureText(candidatePhrase.text).width;
      const textHeight = fontSize * 1.1;

      const attempts = 95;
      for (let attempt = 0; attempt < attempts; attempt++) {
        // Sample random point in bounding box of parametric heart: hx in [-16, 16], hy in [-17, 12]
        const hx = (Math.random() * 2 - 1) * 15.6;
        const hy = -16.8 + Math.random() * 28.5;

        const cx = this.centerX + hx * this.heartScale;
        const cy = this.centerY - (hy + 2.2) * this.heartScale;

        // 1. Check center and all 8 perimeter points of rotated text box against heart polygon
        const hw = textWidth * 0.52 + 3;
        const hh = textHeight * 0.52 + 2;

        if (!this.isPointInHeart(cx, cy)) continue;

        const checkOffsets = [
          { dx: -hw, dy: -hh },
          { dx: hw, dy: -hh },
          { dx: hw, dy: hh },
          { dx: -hw, dy: hh },
          { dx: 0, dy: -hh },
          { dx: 0, dy: hh },
          { dx: -hw, dy: 0 },
          { dx: hw, dy: 0 }
        ];

        let allInside = true;
        for (const off of checkOffsets) {
          const rx = cx + off.dx * cosA - off.dy * sinA;
          const ry = cy + off.dx * sinA + off.dy * cosA;
          if (!this.isPointInHeart(rx, ry)) {
            allInside = false;
            break;
          }
        }
        if (!allInside) continue;

        // 2. Bounding-box collision test against existing phrases
        const rotW = Math.abs(textWidth * cosA) + Math.abs(textHeight * sinA);
        const rotH = Math.abs(textWidth * sinA) + Math.abs(textHeight * cosA);

        if (!this.hasCollision(cx, cy, rotW, rotH)) {
          const color =
            this.palette[Math.floor(Math.random() * this.palette.length)];

          this.placedPhrases.push({
            text: candidatePhrase.text,
            language: candidatePhrase.language,
            normX: (cx - this.centerX) / this.heartScale,
            normY: (cy - this.centerY) / this.heartScale,
            x: cx,
            y: cy,
            width: rotW,
            height: rotH,
            fontSize,
            baseFontSizeNorm: normSize,
            rotation,
            color,
            spawnTime: now,
            twinklePhase: Math.random() * Math.PI * 2,
            twinkleSpeed: 1.2 + Math.random() * 2.2
          });

          this.placedCount.set(this.placedPhrases.length);
          this.currentLanguage.set(candidatePhrase.language);
          this.currentText.set(candidatePhrase.text);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Checks AABB collision with a small padding so phrases never overlap.
   */
  private hasCollision(cx: number, cy: number, w: number, h: number): boolean {
    const pad = 2.5;
    const halfW = w / 2 + pad;
    const halfH = h / 2 + pad;

    for (let i = 0; i < this.placedPhrases.length; i++) {
      const other = this.placedPhrases[i];
      const oHalfW = other.width / 2;
      const oHalfH = other.height / 2;

      if (
        Math.abs(cx - other.x) < halfW + oHalfW &&
        Math.abs(cy - other.y) < halfH + oHalfH
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Creates floating glowing particles and tiny hearts in the background.
   */
  private initParticles(): void {
    const count = 42;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        size: 3 + Math.random() * 7,
        speedY: 0.25 + Math.random() * 0.55,
        speedX: (Math.random() - 0.5) * 0.3,
        opacity: 0.15 + Math.random() * 0.45,
        color: this.palette[Math.floor(Math.random() * this.palette.length)],
        isMiniHeart: Math.random() > 0.35,
        pulsePhase: Math.random() * Math.PI * 2
      });
    }
  }

  /**
   * Main 60fps animation loop driven by requestAnimationFrame.
   */
  private renderLoop(now: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 1. Clear full-screen black canvas
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Render rising background particles & tiny glowing hearts
    this.renderBackgroundParticles(now);

    if (this.started) {
      // 3. Spawn new phrases one by one with accelerating speed until full
      if (!this.isHeartFull() && now - this.lastSpawnTime >= this.spawnInterval) {
        const placed = this.tryPlaceNextPhrase(now);
        this.lastSpawnTime = now;

        if (placed) {
          this.consecutiveMisses = 0;
          // Accelerate spawn rate smoothly from 210ms down to 22ms
          this.spawnInterval = Math.max(22, this.spawnInterval * 0.968);
        } else {
          this.consecutiveMisses++;
        }

        // Mark heart as full when densely packed or no free space remains
        if (this.consecutiveMisses >= 14 || this.placedPhrases.length >= 260) {
          this.isHeartFull.set(true);
          this.fullTimestamp = now;
        }
      }

      // 4. Compute heartbeat pulse scale (1 -> 1.04 -> 1) once the heart is full
      let heartbeatScale = 1;
      if (this.isHeartFull()) {
        const elapsedSec = (now - this.fullTimestamp) / 1000;
        // Smooth lub-dub style heartbeat wave
        const beat = Math.pow(Math.max(0, Math.sin(elapsedSec * Math.PI * 1.6)), 4);
        heartbeatScale = 1 + 0.04 * beat;
      }

      ctx.save();
      ctx.translate(this.centerX, this.centerY);
      ctx.scale(heartbeatScale, heartbeatScale);
      ctx.translate(-this.centerX, -this.centerY);

      // 5. Render soft glowing heart outline so the shape is always unmistakable
      this.renderHeartOutline();

      // 6. Render all placed "I love you" phrases
      this.renderPlacedPhrases(now);

      ctx.restore();
    }

    ctx.restore();
    this.animationFrameId = requestAnimationFrame((t) => this.renderLoop(t));
  }

  /**
   * Draws a subtle crimson glow along the parametric heart outline.
   */
  private renderHeartOutline(): void {
    if (this.heartPolygon.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.heartPolygon[0].x, this.heartPolygon[0].y);
    for (let i = 1; i < this.heartPolygon.length; i++) {
      ctx.lineTo(this.heartPolygon[i].x, this.heartPolygon[i].y);
    }
    ctx.closePath();

    ctx.strokeStyle = 'rgba(255, 23, 68, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#ff1744';
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Renders each phrase with its entrance animation (scale 0.3->1, opacity 0->1,
   * blur->sharp, glow pulse) and subtle twinkling once the heart is full.
   */
  private renderPlacedPhrases(now: number): void {
    const ctx = this.ctx;
    const entranceDuration = 550; // ms for each phrase's fade-in animation
    const heartFull = this.isHeartFull();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < this.placedPhrases.length; i++) {
      const p = this.placedPhrases[i];
      const age = now - p.spawnTime;
      const t = Math.min(1, age / entranceDuration);

      // Ease-out cubic for smooth scale (0.3 -> 1) and opacity (0 -> 1)
      const easeOut = 1 - Math.pow(1 - t, 3);
      const scale = 0.3 + 0.7 * easeOut;
      let opacity = easeOut;

      // Subtle twinkling of random phrases after the heart is full
      if (heartFull && t >= 1) {
        const twinkle =
          Math.sin((now / 1000) * p.twinkleSpeed + p.twinklePhase) * 0.5 + 0.5;
        opacity = 0.68 + 0.32 * twinkle;
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.scale(scale, scale);

      // Small blur -> sharp during entrance animation
      if (t < 0.85) {
        const blurPx = ((1 - t / 0.85) * 3.5).toFixed(1);
        ctx.filter = `blur(${blurPx}px)`;
      }

      // Gentle glow pulse when appearing, settling to a soft red glow
      const glowPulse = t < 1 ? Math.sin(t * Math.PI) * 18 : 0;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 + glowPulse;

      ctx.globalAlpha = opacity;
      ctx.fillStyle = p.color;
      ctx.font = `700 ${p.fontSize}px "Noto Sans", "Noto Sans Georgian", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans Thai", "Noto Sans Devanagari", "Noto Sans Arabic", sans-serif`;
      ctx.fillText(p.text, 0, 0);

      ctx.restore();
    }
  }

  /**
   * Renders slowly rising glowing particles and mini hearts in the background.
   */
  private renderBackgroundParticles(now: number): void {
    const ctx = this.ctx;
    for (const pt of this.particles) {
      pt.y -= pt.speedY;
      pt.x += pt.speedX;

      if (pt.y < -20) {
        pt.y = this.height + 20;
        pt.x = Math.random() * this.width;
      }
      if (pt.x < -20) pt.x = this.width + 20;
      if (pt.x > this.width + 20) pt.x = -20;

      const pulse =
        0.75 + 0.25 * Math.sin(now * 0.002 + pt.pulsePhase);

      ctx.save();
      ctx.globalAlpha = pt.opacity * pulse;
      ctx.fillStyle = pt.color;
      ctx.shadowColor = pt.color;
      ctx.shadowBlur = 10;

      if (pt.isMiniHeart) {
        this.drawMiniHeart(ctx, pt.x, pt.y, pt.size);
      } else {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawMiniHeart(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number
  ): void {
    ctx.beginPath();
    const topCurveHeight = size * 0.3;
    ctx.moveTo(x, y + topCurveHeight);
    ctx.bezierCurveTo(
      x,
      y,
      x - size / 2,
      y,
      x - size / 2,
      y + topCurveHeight
    );
    ctx.bezierCurveTo(
      x - size / 2,
      y + (size + topCurveHeight) / 2,
      x,
      y + (size + topCurveHeight) / 1.5,
      x,
      y + size
    );
    ctx.bezierCurveTo(
      x,
      y + (size + topCurveHeight) / 1.5,
      x + size / 2,
      y + (size + topCurveHeight) / 2,
      x + size / 2,
      y + topCurveHeight
    );
    ctx.bezierCurveTo(
      x + size / 2,
      y,
      x,
      y,
      x,
      y + topCurveHeight
    );
    ctx.closePath();
    ctx.fill();
  }
}