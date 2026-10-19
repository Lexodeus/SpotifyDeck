// Adapted from DeckWebBrowser's menu patch (GPL-3.0, Jesse Bofill)
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";
import { FC, ReactElement, ReactNode } from "react";
import { FaSpotify } from "react-icons/fa";
import { closeSpotify, settings, useSpotifyState } from "./backend";
import { isMenuEntry, placePositionedMenuItems } from "./menuOrder";
import { routePath } from "./routes";

interface MainMenuItemProps {
  route: string;
  label: ReactNode;
  onFocus?: () => void;
  onGamepadFocus?: () => void;
  icon?: ReactElement;
  children?: ReactNode;
  onSecondaryButton?: () => void;
  onSecondaryActionDescription?: ReactNode;
}

const log = (...args: unknown[]) => console.log("[SpotifyDeck] Menu patch:", ...args);

export function patchMenu() {
  const reactTree = getReactRoot(document.getElementById("root") as HTMLElement);
  const menuNode = findInReactTree(reactTree, (node) => node?.memoizedProps?.navID == "MainNavMenuContainer");
  if (!menuNode || !menuNode.return?.type) {
    log("Failed to find main menu root node.");
    return () => {};
  }
  const orig = menuNode.return.type;
  let patchedInnerMenu: any;
  let unpatched = false;
  const menuWrapper = (props: any) => {
    const ret = orig(props);
    // Another plugin wrapped the menu after this one and still calls through, so stay as a pass-through
    if (unpatched) return ret;
    if (!ret?.props?.children?.props?.children?.[0]?.type) {
      log("The main menu element could not be found at the expected location. Valve may have changed it.");
      return ret;
    }
    if (patchedInnerMenu) {
      ret.props.children.props.children[0].type = patchedInnerMenu;
    } else {
      afterPatch(ret.props.children.props.children[0], "type", (_: any, ret: any) => {
        const isMenuItemElt = (e: any) =>
          e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus) && e.props.route && e.type?.toString;
        const menuItems = findInReactTree(ret, (node) => Array.isArray(node) && node.some(isMenuItemElt)) as any[];
        if (!menuItems) {
          log("Could not find menu items to patch.");
          return ret;
        }
        if (!menuItems.some((item) => item?.key === "spotify")) {
          // Steam's own entries with a route (not running games) render with the component to copy
          const menuItem = menuItems.find((e) => isMenuItemElt(e) && isMenuEntry(e)) as
            | { props: MainMenuItemProps; type: FC<MainMenuItemProps> }
            | undefined;
          if (!menuItem) {
            log("Could not find a menu item to copy.");
            return ret;
          }
          menuItems.push(
            <SpotifyMenuItem
              key="spotify"
              route={routePath}
              label="Spotify"
              menuPosition={settings.menuPosition}
              menuYieldsOnTie
              onFocus={menuItem.props.onFocus}
              onGamepadFocus={menuItem.props.onGamepadFocus}
              useIconAsProp={!!menuItem.props.icon}
              MenuItemComponent={menuItem.type}
            />
          );
        }
        const siblings = findInReactTree(ret, (node) => Array.isArray(node) && node.includes(menuItems)) as any[];
        placePositionedMenuItems(menuItems, siblings);

        return ret;
      });
      patchedInnerMenu = ret.props.children.props.children[0].type;
    }
    return ret;
  };
  menuNode.return.type = menuWrapper;
  if (menuNode.return.alternate) {
    menuNode.return.alternate.type = menuNode.return.type;
  }

  return () => {
    unpatched = true;
    // Restoring orig here would also drop the wrappers of plugins that patched after this one
    if (menuNode.return.type !== menuWrapper) return;
    menuNode.return.type = orig;
    if (menuNode.return.alternate) {
      menuNode.return.alternate.type = menuNode.return.type;
    }
  };
}

export interface MenuEntryInfo {
  /** Its position as menuPosition counts it: every entry in the menu other than Spotify, from 1 */
  position: number;
  label: string;
  /** False when a theme hides it */
  visible: boolean;
  /** Another plugin's entry that asked for this exact position, which it keeps over Spotify */
  claimed: boolean;
}

// The menu's entries and grouping divs are plain children of this element (see menuOrder.ts)
function findEntriesElementFiber(fiber: any, depth = 0): any {
  for (let f = fiber; f && depth < 12; f = f.sibling) {
    const children = f.memoizedProps?.children;
    if (typeof f.type === "string" && Array.isArray(children) && Array.isArray(children[0])) return f;
    const found = findEntriesElementFiber(f.child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The Steam menu's entries as last rendered, with whether each is visible. Read from the rendered menu, so it
 * includes other plugins' entries and reflects theme hiding. Undefined if the menu can't be read.
 */
export function readMenuEntries(): MenuEntryInfo[] | undefined {
  try {
    const reactTree = getReactRoot(document.getElementById("root") as HTMLElement);
    const menuNode = findInReactTree(reactTree, (node) => node?.memoizedProps?.navID == "MainNavMenuContainer");
    const fiber = findEntriesElementFiber(menuNode?.child);
    const element = fiber?.stateNode as HTMLElement | undefined;
    if (!element) return undefined;

    // Elements in render order, with the plugin groups opened up
    const flatten = (nodes: any[]): any[] =>
      nodes.flatMap((e) =>
        Array.isArray(e) ? flatten(e) : typeof e?.key === "string" && e.key.startsWith("menu-plugins-group:") ? flatten(e.props.children) : [e]
      );
    const rendered = flatten(fiber.memoizedProps.children).filter(
      (e) => e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus)
    );
    const items = Array.from(element.querySelectorAll<HTMLElement>("[role=menuitem]"));
    if (items.length !== rendered.length) return undefined;

    const view = element.ownerDocument.defaultView ?? window;
    const entries: MenuEntryInfo[] = [];
    rendered.forEach((e, index) => {
      if (!isMenuEntry(e) || e.key === "spotify") return;
      const position = entries.length + 1;
      entries.push({
        position,
        claimed: e.props.menuPosition === position && !e.props.menuYieldsOnTie,
        label: items[index].textContent?.trim() || (typeof e.props.label === "string" ? e.props.label : "?"),
        visible: view.getComputedStyle(items[index]).display !== "none",
      });
    });
    return entries;
  } catch (e) {
    log("Couldn't read the menu's entries:", e);
    return undefined;
  }
}

// Shows that Spotify is running: Spotify green mixed 50/50 with the menu's icon grey rgb(184, 188, 191)
const runningIconStyle = { color: "#6bca90" };

interface SpotifyMenuItemProps extends MainMenuItemProps {
  menuPosition: number;
  menuYieldsOnTie: boolean;
  MenuItemComponent: FC<MainMenuItemProps>;
  useIconAsProp: boolean;
}

const SpotifyMenuItem: FC<SpotifyMenuItemProps> = ({
  MenuItemComponent,
  useIconAsProp,
  menuPosition: _position,
  menuYieldsOnTie: _yields,
  ...props
}) => {
  const { running } = useSpotifyState();
  const icon = <FaSpotify style={running ? runningIconStyle : {}} />;

  return (
    <MenuItemComponent
      {...props}
      {...(useIconAsProp ? { icon } : { children: icon })}
      onSecondaryActionDescription={running ? "Close Spotify" : ""}
      onSecondaryButton={running ? () => closeSpotify() : undefined}
    />
  );
};
