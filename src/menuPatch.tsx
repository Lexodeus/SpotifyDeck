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
              onFocus={menuItem.props.onFocus}
              onGamepadFocus={menuItem.props.onGamepadFocus}
              useIconAsProp={!!menuItem.props.icon}
              MenuItemComponent={menuItem.type}
            />
          );
        }
        placePositionedMenuItems(menuItems);

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

// Spotify green mixed 50/50 with the menu's icon grey rgb(184, 188, 191). No CSS filter (e.g. a drop-shadow glow):
// Steam's renderer hangs repainting a filtered icon when the Steam menu opens over Spotify.
const runningIconStyle = { color: "#6bca90" };

interface SpotifyMenuItemProps extends MainMenuItemProps {
  menuPosition: number;
  MenuItemComponent: FC<MainMenuItemProps>;
  useIconAsProp: boolean;
}

const SpotifyMenuItem: FC<SpotifyMenuItemProps> = ({ MenuItemComponent, useIconAsProp, menuPosition: _, ...props }) => {
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
