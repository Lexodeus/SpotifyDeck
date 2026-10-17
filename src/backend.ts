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
  // 0–100: how brightly the Steam menu icon lights up while Spotify runs
  indicatorBrightness: 50,
};
const settingsListeners = new Set<() => void>();
const notifySettings = () => settingsListeners.forEach((listener) => listener());

/** Re-renders when a setting changes, e.g. so the menu icon follows the brightness slider. */
export function useSettings() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    settingsListeners.add(listener);
    return () => void settingsListeners.delete(listener);
  }, []);
  return settings;
}

export async function loadSettings() {
  settings.menuPosition = await getSetting("menuPosition", LAST_MENU_POSITION);
  settings.indicatorBrightness = await getSetting("indicatorBrightness", 50);
  notifySettings();
}

export async function setIndicatorBrightness(brightness: number) {
  settings.indicatorBrightness = brightness;
  notifySettings();
  await setSetting("indicatorBrightness", brightness);
}

export async function setMenuPosition(position: number) {
  settings.menuPosition = position;
  await setSetting("menuPosition", position);
}
