import { ConfirmModal, DialogButton, Field, Focusable, ModalRoot, Navigation, Router, showModal } from "@decky/ui";
import { FC, useEffect, useState } from "react";
import { addLayoutController, prepareLayout, settings } from "./backend";

/**
 * Steam Input treats Spotify's window as an app of its own (the placeholder ID the backend gives it, without its top
 * byte) and loads a controller layout for it. Left alone that's Steam's gamepad layout, which Spotify ignores, so
 * SpotifyDeck picks its own: Steam's Web Browser layout with a few buttons changed (see build_layout in main.py).
 */
const CONTROLLER_APP_ID = 5263188;

// Steam only has a Web Browser layout for the Steam Deck's controls (eControllerType 4)
const LAYOUT_TEMPLATES: Record<number, string> = { 4: "controller_neptune" };

interface Controller {
  nControllerIndex: number;
  eControllerType: number;
  strSerialNumber: string;
  strName?: string;
}

interface LayoutConfig {
  Title: string;
  URL: string;
}

const store = () => (window as any).controllerConfiguratorStore;

function controllers(): Controller[] {
  return store()?.m_controllerList ?? [];
}

// Account 0: right after Steam starts, before the user is signed in
const NO_STEAM_ID = "76561197960265728";

function steamId(): string | undefined {
  const id: string | undefined = (window as any).App?.m_CurrentUser?.strSteamID;
  return id && id !== NO_STEAM_ID ? id : undefined;
}

const currentLayout = (controller: Controller): Promise<LayoutConfig> =>
  (SteamClient.Input as any).GetConfigForAppAndController(CONTROLLER_APP_ID, controller.nControllerIndex);

async function selectLayout(controller: Controller, replace: boolean) {
  const id = steamId();
  const template = LAYOUT_TEMPLATES[controller.eControllerType];
  if (!id || !template) throw new Error("This controller has no Web Browser layout to start from");
  const { url, title } = await prepareLayout(id, controller.strSerialNumber, template, replace);
  if (!url) return title;
  store().SetActiveConfigForApp(CONTROLLER_APP_ID, controller.nControllerIndex, url, false);
  console.log(`[SpotifyDeck] Selected the SpotifyDeck layout for controller ${controller.strSerialNumber}`);
  return null;
}

/**
 * Steam's controller settings page leaves a layout's name blank when the app has no name in Steam, which Spotify's
 * placeholder app doesn't. While one of those pages is open, give it the name "Spotify".
 */
export function nameSpotifyForControllerSettings() {
  const detailsStore = (window as any).appDetailsStore;
  const original = detailsStore?.GetAppDetails;
  if (typeof original !== "function") {
    console.error("[SpotifyDeck] Steam's app details weren't found, Steam's controller page shows no layout name.");
    return () => {};
  }
  const hadOwn = Object.prototype.hasOwnProperty.call(detailsStore, "GetAppDetails");
  const getAppDetails = function (this: any, appId: number, ...rest: any[]) {
    const details = original.call(this, appId, ...rest);
    if (details || appId != CONTROLLER_APP_ID) return details;
    const path: string | undefined = (Router.WindowStore?.GamepadUIMainWindowInstance as any)?.m_history?.location
      ?.pathname;
    return path?.includes("controllerconfigurator")
      ? { unAppID: CONTROLLER_APP_ID, strDisplayName: "Spotify" }
      : details;
  };
  detailsStore.GetAppDetails = getAppDetails;
  return () => {
    // Only undo it if nothing wrapped it after this
    if (detailsStore.GetAppDetails !== getAppDetails) return;
    if (hadOwn) detailsStore.GetAppDetails = original;
    else delete detailsStore.GetAppDetails;
  };
}

let settingUp: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

// When Steam starts, the plugin loads before Steam knows the user and the controllers
const RETRY_MS = 2000;
const MAX_RETRIES = 30;

/**
 * Picks SpotifyDeck's layout for each controller that has nothing picked for Spotify yet. Each controller is only set
 * up once, so a layout you pick yourself later stays.
 */
export function setUpLayouts(retries = MAX_RETRIES): Promise<void> {
  clearTimeout(retryTimer);
  // Cleared once it settles. (Clearing it inside an async function that returns before its first await would run
  // before this assignment, and leave every later call waiting on a finished run.)
  settingUp ??= setUp(retries).finally(() => {
    settingUp = undefined;
  });
  return settingUp;
}

async function setUp(retries: number) {
  if (!store() || !steamId() || !controllers().length) {
    if (retries > 0 && !stopped) retryTimer = setTimeout(() => setUpLayouts(retries - 1), RETRY_MS);
    return;
  }
  for (const controller of controllers()) {
    const serial = controller.strSerialNumber;
    if (!serial || !LAYOUT_TEMPLATES[controller.eControllerType] || settings.layoutControllers.includes(serial)) {
      continue;
    }
    try {
      const layout = await currentLayout(controller);
      if (layout?.URL?.startsWith("default://")) await selectLayout(controller, true);
      await addLayoutController(serial);
    } catch (e) {
      console.error(`[SpotifyDeck] Couldn't set up the controller layout for ${serial}:`, e);
    }
  }
}

export function stopSettingUpLayouts() {
  stopped = true;
  clearTimeout(retryTimer);
}

const shortcuts: [string, string][] = [
  ["A", "Play / pause"],
  ["L1 / R1", "Previous / next song"],
  ["D-pad left / right", "Back / forward 5 seconds"],
  ["D-pad up / down", "Spotify's volume up / down"],
  ["Right trackpad or right stick", "Move the pointer. Press it down to click."],
  ["R2 / L2", "Click / right-click"],
  ["Left stick or left trackpad", "Scroll"],
  ["Y", "Enter"],
  ["B", "Back"],
  ["X", "Type with Steam's keyboard, e.g. into the search bar"],
  ["Menu (☰)", "Open Spotify's search: find a song, artist or playlist by typing its name. Press again to close it."],
  ["View (⧉)", "Escape: closes popups and menus"],
  ["L4 / R4", "Middle click / hold Ctrl"],
  ["Steam + X", "Type with Steam's keyboard, with any layout"],
];

function editInSteam(close: () => void) {
  close();
  Navigation.CloseSideMenus();
  Navigation.Navigate(`/app/${CONTROLLER_APP_ID}/controllerconfigurator`);
}

const ButtonsModal: FC<{ closeModal?: () => void }> = ({ closeModal }) => {
  const close = () => closeModal?.();
  const controller = controllers().find((c) => LAYOUT_TEMPLATES[c.eControllerType]) ?? controllers()[0];
  const supported = !!controller && !!LAYOUT_TEMPLATES[controller.eControllerType];
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    if (controller) currentLayout(controller).then(setLayout, (e) => setError(String(e)));
  };
  useEffect(refresh, []);

  const ours = layout?.URL?.startsWith("autosave://") && layout.URL.endsWith(`/${controller?.strSerialNumber}.vdf`);
  const isSpotifyDeck = ours && layout?.Title === "SpotifyDeck";

  const useOurs = async () => {
    if (!controller) return;
    try {
      setError(null);
      // The file Steam saved for this controller holds another layout. That's the one in use when ours is true.
      const otherTitle = await selectLayout(controller, !ours);
      if (otherTitle !== null) {
        showModal(
          <ConfirmModal
            strTitle="Replace your layout?"
            strDescription={`Spotify uses your layout "${otherTitle}". SpotifyDeck's layout replaces it, and your changes to it are lost.`}
            strOKButtonText="Replace"
            onOK={() => selectLayout(controller, true).then(refresh, (e) => setError(String(e)))}
          />
        );
        return;
      }
      setTimeout(refresh, 500);
    } catch (e) {
      setError(String(e));
    }
  };

  let status: string;
  if (!controller) status = "No controller found.";
  else if (!layout) status = "";
  else if (isSpotifyDeck) status = "Spotify uses SpotifyDeck's layout. If you changed it in Steam, your changes apply.";
  else status = `Spotify uses another layout ("${layout.Title}"), so these buttons may do something else.`;

  return (
    <ModalRoot onCancel={close} onEscKeypress={close}>
      <div style={{ fontSize: "22px", fontWeight: "bold", marginBottom: "8px" }}>Controller buttons in Spotify</div>
      {status && <div style={{ marginBottom: "12px", opacity: 0.8 }}>{status}</div>}
      {!supported && controller && (
        <div style={{ marginBottom: "12px", opacity: 0.8 }}>
          SpotifyDeck's layout is only made for the Steam Deck's controls. Pick a layout for this controller in Steam.
        </div>
      )}
      {/* Focusable rows, so the D-pad scrolls through the list */}
      <div style={{ marginBottom: "12px" }}>
        {shortcuts.map(([button, action]) => (
          <Field key={button} label={button} focusable highlightOnFocus padding="compact" bottomSeparator="none">
            <div style={{ textAlign: "right" }}>{action}</div>
          </Field>
        ))}
      </div>
      {error && <div style={{ color: "#ff6b6b", marginBottom: "12px" }}>{error}</div>}
      <Focusable style={{ display: "flex", gap: "12px" }} flow-children="horizontal">
        {controller && <DialogButton onClick={() => editInSteam(close)}>Edit layout in Steam</DialogButton>}
        {supported && layout && !isSpotifyDeck && (
          <DialogButton onClick={useOurs}>Use SpotifyDeck's layout</DialogButton>
        )}
        <DialogButton onClick={close}>Close</DialogButton>
      </Focusable>
    </ModalRoot>
  );
};

export const showButtonsModal = () => showModal(<ButtonsModal />);
