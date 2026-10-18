import { Injectable, signal } from '@angular/core';

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: any;
  }
}

@Injectable({
  providedIn: 'root'
})
export class MusicService {
  private readonly videoId = 'e8cuqDEY474'; // Massive Attack – Angel
  private readonly fallbackMp3Path = 'assets/angel.mp3';

  // ─── LOOP SECTION (only this part of the song repeats) ──────────────
  // Set these to the exact seconds where the "love you" part begins/ends.
  // Example: 2:10 -> 2 * 60 + 10 = 130
  private readonly loopStart = 2 * 60 + 10; // 130 s
  private readonly loopEnd = 2 * 60 + 25; // 145 s  <-- PLACEHOLDER, adjust!
  // ────────────────────────────────────────────────────────────────────

  private ytPlayer: any = null;
  private isYtReady = false;
  private pendingPlay = false;
  private hasStarted = false;
  private loopTimer: ReturnType<typeof setInterval> | null = null;

  // Fallback HTML5 Audio element if YouTube embed is disabled/unavailable
  private fallbackAudio: HTMLAudioElement | null = null;
  private usingFallback = false;

  // Reactive signal for mute state
  public readonly isMuted = signal<boolean>(false);

  constructor() {
    this.loadYouTubeApi();

    // TEMPORARY helper to find exact times: open the browser console and
    // type  angelTime()  while the song plays. Remove when you're done.
    if (typeof window !== 'undefined') {
      (window as any).angelTime = () => this.getCurrentTime();
    }
  }

  /**
   * Dynamically injects the YouTube IFrame Player API script into the document.
   */
  private loadYouTubeApi(): void {
    if (typeof window === 'undefined') return;

    if (window.YT && window.YT.Player) {
      this.createYouTubePlayer();
      return;
    }

    const existingScript = document.getElementById('yt-iframe-api');
    if (!existingScript) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(tag);
    }

    window.onYouTubeIframeAPIReady = () => {
      this.createYouTubePlayer();
    };
  }

  /**
   * Creates a tiny hidden 1x1 YouTube player for background audio playback.
   */
  private createYouTubePlayer(): void {
    let container = document.getElementById('yt-hidden-player');
    if (!container) {
      container = document.createElement('div');
      container.id = 'yt-hidden-player';
      container.style.position = 'fixed';
      container.style.bottom = '0';
      container.style.left = '0';
      container.style.width = '1px';
      container.style.height = '1px';
      container.style.opacity = '0.01';
      container.style.pointerEvents = 'none';
      container.style.zIndex = '-1';
      document.body.appendChild(container);
    }

    this.ytPlayer = new window.YT.Player('yt-hidden-player', {
      height: '1',
      width: '1',
      videoId: this.videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 180,
        rel: 0,
        start: this.loopStart
        // No built-in `loop`/`playlist`: we loop the chosen section manually.
      },
      events: {
        onReady: () => {
          this.isYtReady = true;
          this.ytPlayer.setVolume(85);
          if (this.pendingPlay) {
            this.play();
          }
        },
        onStateChange: (event: any) => {
          // Safety net: if the track somehow reaches the end, go back to the section
          if (event.data === window.YT.PlayerState.ENDED) {
            this.ytPlayer.seekTo(this.loopStart, true);
            this.ytPlayer.playVideo();
          }
        },
        onError: () => {
          // If embedding is disabled or blocked, switch to local MP3 fallback
          this.activateFallbackAudio();
        }
      }
    });
  }

  /**
   * Starts playing the background music (called upon user interaction).
   */
  public play(): void {
    this.pendingPlay = true;
    this.startLoopWatcher();

    if (this.usingFallback) {
      this.fallbackAudio?.play().catch(() => {});
      return;
    }

    if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.playVideo === 'function') {
      try {
        if (this.isMuted()) {
          this.ytPlayer.mute();
        } else {
          this.ytPlayer.unMute();
        }

        // Make sure the very first start is at the beginning of the section
        if (!this.hasStarted) {
          this.ytPlayer.seekTo(this.loopStart, true);
          this.hasStarted = true;
        }

        this.ytPlayer.playVideo();
      } catch {
        this.activateFallbackAudio();
      }
    }
  }

  /**
   * Toggles mute/unmute state for the active player.
   */
  public toggleMute(): void {
    const nextMute = !this.isMuted();
    this.isMuted.set(nextMute);

    if (this.usingFallback && this.fallbackAudio) {
      this.fallbackAudio.muted = nextMute;
      return;
    }

    if (this.isYtReady && this.ytPlayer) {
      if (nextMute) {
        this.ytPlayer.mute();
      } else {
        this.ytPlayer.unMute();
      }
    }
  }

  /**
   * Current playback position in seconds (YouTube or fallback MP3).
   */
  private getCurrentTime(): number {
    if (this.usingFallback && this.fallbackAudio) {
      return this.fallbackAudio.currentTime;
    }
    if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
      return this.ytPlayer.getCurrentTime();
    }
    return 0;
  }

  /**
   * Checks the position every 100 ms and jumps back to loopStart
   * as soon as loopEnd is reached.
   */
  private startLoopWatcher(): void {
    if (this.loopTimer) return;

    this.loopTimer = setInterval(() => {
      if (this.getCurrentTime() < this.loopEnd) return;

      if (this.usingFallback && this.fallbackAudio) {
        this.fallbackAudio.currentTime = this.loopStart;
      } else if (this.isYtReady && this.ytPlayer) {
        this.ytPlayer.seekTo(this.loopStart, true);
      }
    }, 100);
  }

  /**
   * Fallback to local MP3 file (/assets/angel.mp3) if YouTube embed fails.
   * Uses the same start point and loop section.
   */
  private activateFallbackAudio(): void {
    if (this.usingFallback) return;
    this.usingFallback = true;

    const audio = new Audio(this.fallbackMp3Path);
    audio.loop = false;
    audio.volume = 0.85;
    audio.muted = this.isMuted();

    // currentTime can only be set once metadata is loaded
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = this.loopStart;
    });

    audio.addEventListener('ended', () => {
      audio.currentTime = this.loopStart;
      audio.play().catch(() => {});
    });

    this.fallbackAudio = audio;

    if (this.pendingPlay) {
      audio.play().catch(() => {
        console.warn(
          'YouTube embed unavailable and no fallback MP3 found at assets/angel.mp3.'
        );
      });
    }
  }
}