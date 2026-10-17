import { Router } from "@decky/ui";
import { FC } from "react";
import { FaSpotify } from "react-icons/fa";
import { hideSpotify, setSteamOverlayOpen, showSpotify, useSpotifyState } from "./backend";

export const routePath = "/spotify";

interface History {
  listen(listener: (location: { pathname: string }, action: "PUSH" | "POP" | "REPLACE") => void): () => void;
}

const mainWindow = () => Router.WindowStore?.GamepadUIMainWindowInstance as any;

// With no game running, Steam draws these inside its own window, which is underneath Spotify
function isSteamOverlayOpen() {
  try {
    const window = mainWindow();
    return !!(
      window?.MenuStore?.IsAnySideMenuVisible?.() ||
      window?.m_bShowingGlobalModal ||
      // A getter returning a subscribable value ({ m_currentValue }), not a function
      window?.m_VirtualKeyboardManager?.IsShowingVirtualKeyboard?.m_currentValue
    );
  } catch (e) {
    console.error("[SpotifyDeck] Couldn't check Steam's menus:", e);
    return false;
  }
}

/**
 * Shows Spotify while Steam is on the Spotify route and hides it when Steam navigates anywhere else.
 * Steam's menu pushes the route again when Spotify is picked while already on it, which re-shows it
 * after a game took the screen back.
 */
export function watchNavigation() {
  const history = mainWindow()?.m_history as History | undefined;
  if (!history?.listen) {
    console.error("[SpotifyDeck] Steam's navigation history wasn't found, the Spotify page can't open Spotify.");
    return () => {};
  }
  let onSpotify = false;
  let overlayOpen = false;
  const stopListening = history.listen((location, action) => {
    if (location.pathname === routePath) {
      // Steam replaces the current entry to store focus state; only a real navigation should re-show Spotify
      if (!onSpotify || action !== "REPLACE") showSpotify();
      onSpotify = true;
    } else if (onSpotify) {
      onSpotify = false;
      overlayOpen = false;
      hideSpotify();
    }
  });
  const overlayTimer = setInterval(() => {
    if (!onSpotify) return;
    const open = isSteamOverlayOpen();
    if (open !== overlayOpen) {
      overlayOpen = open;
      setSteamOverlayOpen(open);
    }
  }, 100);
  return () => {
    stopListening();
    clearInterval(overlayTimer);
  };
}

/** Steam's page behind Spotify. It's only seen while Spotify starts, or when something went wrong. */
export const SpotifyPage: FC = () => {
  const { installed, running, launching, error } = useSpotifyState();

  let message = "Press the Steam button to go back to Steam. Spotify keeps playing in the background.";
  if (!installed) message = "Spotify isn't installed. Install it from Discover in Desktop Mode.";
  else if (error) message = error;
  else if (launching) message = "Starting Spotify…";
  else if (!running) message = "Spotify is closed. Pick Spotify in the Steam menu to open it again.";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "16px",
        padding: "0 16px",
        textAlign: "center",
        background: "#121212",
      }}
    >
      <FaSpotify size="64px" color="#1ed760" />
      <div style={{ fontSize: "18px", maxWidth: "560px" }}>{message}</div>
    </div>
  );
};
