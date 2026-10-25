import { addEventListener, callable, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";

export interface SpotifyState {
  installed: boolean;
  running: boolean;
  launching: boolean;
  shown: boolean;
  error: string | null;
}

export const showSpotify = callable<[], void>("show");
export const hideSpotify = callable<[], void>("hide");
export const closeSpotify = callable<[], void>("close");
export const setSteamOverlayOpen = callable<[isOpen: boolean], void>("set_steam_overlay_open");
export const sendText = callable<[text: string], void>("send_text");
export const prepareLayout = callable<
  [steamId: string, serial: string, controllerType: string, replace: boolean],
  { url: string | null; title: string | null }
>("prepare_layout");
const getState = callable<[], SpotifyState>("get_state");
const getSetting = callable<[key: string, fallback: unknown], any>("get_setting");
const setSetting = callable<[key: string, value: unknown], void>("set_setting");

let state: SpotifyState = { installed: true, running: false, launching: false, shown: false, error: null };
const stateListeners = new Set<(state: SpotifyState) => void>();

function setState(next: SpotifyState) {
  state = next;
  stateListeners.forEach((listener) => listener(state));
}

export const refreshState = () => getState().then(setState);

export function onStateChange(listener: (state: SpotifyState) => void) {
  stateListeners.add(listener);
  listener(state);
  return () => void stateListeners.delete(listener);
}

export function listenForState() {
  const listener = addEventListener<[SpotifyState]>("state", setState);
  refreshState();
  return () => removeEventListener("state", listener);
}

export function useSpotifyState() {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    stateListeners.add(setCurrent);
    refreshState();
    return () => void stateListeners.delete(setCurrent);
  }, []);
  return current;
}

// Position 1 puts Spotify first in the Steam menu, LAST_MENU_POSITION after the last entry
export const LAST_MENU_POSITION = 99;

export const settings = {
  menuPosition: LAST_MENU_POSITION,
  // Serial numbers of the controllers whose layout for Spotify was already set up (or picked by you)
  layoutControllers: [] as string[],
};

export async function loadSettings() {
  settings.menuPosition = await getSetting("menuPosition", LAST_MENU_POSITION);
  settings.layoutControllers = await getSetting("layoutControllers", []);
}

export async function addLayoutController(serial: string) {
  if (settings.layoutControllers.includes(serial)) return;
  settings.layoutControllers = [...settings.layoutControllers, serial];
  await setSetting("layoutControllers", settings.layoutControllers);
}

export async function setMenuPosition(position: number) {
  settings.menuPosition = position;
  await setSetting("menuPosition", position);
}
