import { DialogButton, Focusable, Router, TextField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";
import { FaSpotify } from "react-icons/fa";
import { hideSpotify, sendText, setSteamOverlayOpen, showSpotify, useSpotifyState } from "./backend";

export const routePath = "/spotify";

interface History {
  location?: { pathname: string };
  listen(listener: (location: { pathname: string }, action: "PUSH" | "POP" | "REPLACE") => void): () => void;
}

const mainWindow = () => Router.WindowStore?.GamepadUIMainWindowInstance as any;

// Time for Steam to finish handling Steam + X before Spotify steps aside for the text box
const CHORD_RELEASE_DELAY_MS = 400;

function isKeyboardShowing() {
  // A getter returning a subscribable value ({ m_currentValue }), not a function
  return !!mainWindow()?.m_VirtualKeyboardManager?.IsShowingVirtualKeyboard?.m_currentValue;
}

function hideKeyboard() {
  try {
    mainWindow()?.m_VirtualKeyboardManager?.SetVirtualKeyboardHidden?.();
  } catch (e) {
    console.error("[SpotifyDeck] Couldn't hide Steam's keyboard:", e);
  }
}

// With no game running, Steam draws these inside its own window, which is underneath Spotify
function isSteamOverlayOpen() {
  try {
    const window = mainWindow();
    return !!(window?.MenuStore?.IsAnySideMenuVisible?.() || window?.m_bShowingGlobalModal || isKeyboardShowing());
  } catch (e) {
    console.error("[SpotifyDeck] Couldn't check Steam's menus:", e);
    return false;
  }
}

/**
 * Steam's keyboard can't type into Spotify, so opening it on the Spotify page shows a text box
 * on Steam's page instead. Spotify stays out of the way until the text is sent or cancelled.
 */
let composing = false;
const composingListeners = new Set<(composing: boolean) => void>();

function setComposing(next: boolean) {
  if (composing === next) return;
  composing = next;
  composingListeners.forEach((listener) => listener(composing));
}

function useComposing() {
  const [current, setCurrent] = useState(composing);
  useEffect(() => {
    composingListeners.add(setCurrent);
    setCurrent(composing);
    return () => void composingListeners.delete(setCurrent);
  }, []);
  return current;
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
      setComposing(false);
      hideSpotify();
    }
  });
  // After a plugin reload Steam can still be on the Spotify page, with no navigation to tell us
  if (history.location?.pathname === routePath) {
    onSpotify = true;
    showSpotify();
  }
  // Steam + X is sent to the focused app's in-game overlay, which Spotify doesn't have, so Steam shows nothing.
  // Open the text box instead.
  // The message arrives as the Steam button is let go, which is also when Steam gives the controller back to
  // Spotify's (placeholder) controller config. Spotify only steps aside after that, so Steam then switches to its
  // own config and the D-pad works on the keyboard. Stepping aside first leaves the controller on Spotify's config.
  let keyboardRequests: { unregister(): void } | undefined;
  let composeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    keyboardRequests = (SteamClient.Input as any).RegisterForUserKeyboardMessages(() => {
      if (!onSpotify) return;
      clearTimeout(composeTimer);
      composeTimer = setTimeout(() => {
        if (onSpotify) setComposing(true);
      }, CHORD_RELEASE_DELAY_MS);
    });
  } catch (e) {
    console.error("[SpotifyDeck] Couldn't listen for Steam + X:", e);
  }
  const overlayTimer = setInterval(() => {
    if (!onSpotify) return;
    if (isKeyboardShowing()) setComposing(true);
    const open = composing || isSteamOverlayOpen();
    if (open !== overlayOpen) {
      overlayOpen = open;
      setSteamOverlayOpen(open);
    }
  }, 100);
  return () => {
    stopListening();
    keyboardRequests?.unregister();
    clearTimeout(composeTimer);
    clearInterval(overlayTimer);
    setComposing(false);
  };
}

const TextBox: FC = () => {
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // Open Steam's keyboard on the text field, the way selecting it with A would
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = boxRef.current?.querySelector("input");
      if (!input || isKeyboardShowing()) return;
      input.focus();
      input.click();
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const finish = (send: boolean) => {
    if (send && text.trim()) sendText(text);
    setText("");
    hideKeyboard();
    setComposing(false);
  };

  return (
    <div ref={boxRef} style={{ width: "100%", maxWidth: "720px" }}>
      <Focusable
        style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        onCancel={(e) => {
          e.stopPropagation();
          finish(false);
        }}
        onCancelActionDescription="Back to Spotify"
      >
        <div style={{ fontSize: "16px", opacity: 0.8 }}>
          Typed into the text field selected in Spotify, such as the search bar.
        </div>
        <TextField
          focusOnMount
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            }
          }}
        />
        <Focusable style={{ display: "flex", gap: "12px" }} flow-children="horizontal">
          <DialogButton disabled={!text.trim()} onClick={() => finish(true)}>
            Type
          </DialogButton>
          <DialogButton onClick={() => finish(false)}>Cancel</DialogButton>
        </Focusable>
      </Focusable>
    </div>
  );
};

/** Steam's page behind Spotify. It's seen while Spotify starts, while typing text for it, or when something went wrong. */
export const SpotifyPage: FC = () => {
  const { installed, running, launching, error } = useSpotifyState();
  const isComposing = useComposing();

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
      {isComposing && running ? <TextBox /> : <div style={{ fontSize: "18px", maxWidth: "560px" }}>{message}</div>}
    </div>
  );
};
