import { definePlugin, routerHook } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { useState } from "react";
import { FaSpotify } from "react-icons/fa";
import {
  closeSpotify,
  LAST_MENU_POSITION,
  listenForState,
  loadSettings,
  setMenuPosition,
  settings,
  useSpotifyState,
} from "./backend";
import { pauseMenuMusicWhileSpotifyRuns } from "./audioLoader";
import { patchMenu, readMenuEntries } from "./menuPatch";
import { routePath, SpotifyPage, watchNavigation } from "./routes";

/**
 * One option per spot between the entries you can see in the Steam menu. Entries a theme hides are skipped: Spotify
 * goes above the next visible entry either way.
 */
function menuPositionOptions() {
  const entries = readMenuEntries()?.filter((entry) => entry.visible);
  if (!entries?.length) {
    // The menu couldn't be read: plain numbers for Steam's 8 entries
    return [
      ...Array.from({ length: 8 }, (_, i) => ({ data: i + 1, label: `${i + 1}` })),
      { data: LAST_MENU_POSITION, label: "Last" },
    ];
  }
  return [
    ...entries.map((entry, i) => ({ data: entry.position, label: `${i + 1}: above ${entry.label}` })),
    { data: LAST_MENU_POSITION, label: `${entries.length + 1}: last` },
  ];
}

function Content() {
  const { installed, running, launching } = useSpotifyState();
  const [menuPosition, setMenuPositionState] = useState(settings.menuPosition);
  // Read when the panel opens, so it matches the menu as it is now
  const [options] = useState(menuPositionOptions);
  // A saved position above a hidden entry shows as the next visible spot, where Spotify actually appears
  const selected = options.find((option) => option.data >= menuPosition) ?? options[options.length - 1];

  let status = "Not running";
  if (!installed) status = "Not installed. Install Spotify from Discover in Desktop Mode.";
  else if (launching) status = "Starting…";
  else if (running) status = "Running";

  return (
    <PanelSection>
      <PanelSectionRow>
        <div>Spotify: {status}</div>
      </PanelSectionRow>
      {running && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="You can also close it by highlighting Spotify in the Steam menu and pressing X."
            onClick={() => closeSpotify()}
          >
            Close Spotify
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <DropdownItem
          label="Position in Steam menu"
          rgOptions={options}
          selectedOption={selected.data}
          onChange={(option) => {
            setMenuPositionState(option.data);
            setMenuPosition(option.data);
          }}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  loadSettings();
  const stopListeningForState = listenForState();
  routerHook.addRoute(routePath, SpotifyPage, { exact: true });
  const unpatchMenu = patchMenu();
  const stopWatchingNavigation = watchNavigation();
  const stopPausingMenuMusic = pauseMenuMusicWhileSpotifyRuns();

  return {
    name: "SpotifyDeck",
    titleView: <div className={staticClasses.Title}>SpotifyDeck</div>,
    content: <Content />,
    icon: <FaSpotify />,
    onDismount() {
      stopPausingMenuMusic();
      stopWatchingNavigation();
      unpatchMenu();
      routerHook.removeRoute(routePath);
      stopListeningForState();
    },
  };
});
