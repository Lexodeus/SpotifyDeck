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
import { patchMenu } from "./menuPatch";
import { routePath, SpotifyPage, watchNavigation } from "./routes";

const menuPositionOptions = [
  ...Array.from({ length: 8 }, (_, i) => ({ data: i + 1, label: `${i + 1}` })),
  { data: LAST_MENU_POSITION, label: "Last" },
];

function Content() {
  const { installed, running, launching } = useSpotifyState();
  const [menuPosition, setMenuPositionState] = useState(settings.menuPosition);

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
          <ButtonItem layout="below" onClick={() => closeSpotify()}>
            Close Spotify
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <DropdownItem
          label="Position in Steam menu"
          rgOptions={menuPositionOptions}
          selectedOption={menuPosition}
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

  return {
    name: "SpotifyDeck",
    titleView: <div className={staticClasses.Title}>SpotifyDeck</div>,
    content: <Content />,
    icon: <FaSpotify />,
    onDismount() {
      stopWatchingNavigation();
      unpatchMenu();
      routerHook.removeRoute(routePath);
      stopListeningForState();
    },
  };
});
