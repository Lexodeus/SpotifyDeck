import { Router } from "@decky/ui";
import { onStateChange } from "./backend";

/**
 * Audio Loader's menu music, which it shares with other plugins. Audio Loader replaces the object
 * when the music changes. Game Theme Music pauses and resumes it through play/pause on game pages.
 */
interface MenuMusic {
  play(): void;
  pause(): void;
}

const getMenuMusic = () => (window as any).AUDIOLOADER_MENUMUSIC as MenuMusic | undefined;
const noGamesRunning = () => !Router.RunningApps?.length;

// Audio Loader plays its music directly (not through the shared object) when the last game quits,
// so it has to be paused again often enough that nothing is heard
const PAUSE_INTERVAL_MS = 250;

/** Keeps Audio Loader's menu music paused while Spotify is running, and resumes it after. */
export function pauseMenuMusicWhileSpotifyRuns() {
  let guarded: { music: MenuMusic; play: () => void; pause: () => void } | undefined;
  // Whether the music would be playing if Spotify weren't running
  let wantsPlay = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const guard = () => {
    const music = getMenuMusic();
    if (!music) return;
    if (guarded?.music !== music) {
      // A new object means Audio Loader just started music, which it only does with no game running
      wantsPlay = noGamesRunning();
      guarded = { music, play: music.play, pause: music.pause };
      const { pause } = guarded;
      music.play = () => void (wantsPlay = true);
      music.pause = () => {
        wantsPlay = false;
        pause();
      };
    }
    guarded.pause();
  };

  const release = () => {
    clearInterval(timer);
    timer = undefined;
    if (!guarded) return;
    const { music, play, pause } = guarded;
    guarded = undefined;
    music.play = play;
    music.pause = pause;
    if (getMenuMusic() === music && wantsPlay) play();
  };

  const stopListeningForState = onStateChange(({ running }) => {
    if (running && !timer) {
      guard();
      timer = setInterval(guard, PAUSE_INTERVAL_MS);
    } else if (!running && timer) {
      release();
    }
  });

  // Follow Audio Loader's own rule: music plays only while no game is running
  const appLifetime = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((update: { bRunning: boolean }) => {
    if (update.bRunning) wantsPlay = false;
    else setTimeout(() => (wantsPlay = noGamesRunning()), 500);
  });

  return () => {
    stopListeningForState();
    appLifetime.unregister();
    release();
  };
}
