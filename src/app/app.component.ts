import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeartComponent } from './heart/heart.component';
import { MusicService } from './music.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, HeartComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  public readonly musicService = inject(MusicService);
  public readonly hasStarted = signal<boolean>(false);

  /**
   * Starts both the music playback and the heart canvas animation together.
   */
  public startExperience(): void {
    this.hasStarted.set(true);
    this.musicService.play();
  }

  /**
   * Toggles background music mute/unmute state.
   */
  public toggleMute(): void {
    this.musicService.toggleMute();
  }
}