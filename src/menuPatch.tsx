// Adapted from DeckWebBrowser's menu patch (GPL-3.0, Jesse Bofill)
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";
import { FC, ReactElement, ReactNode } from "react";
import { FaSpotify } from "react-icons/fa";
import { closeSpotify, settings, useSpotifyState } from "./backend";
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
  const menuWrapper = (props: any) => {
    const ret = orig(props);
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
        if (menuItems.some((item) => item?.key === "spotify")) return ret;

        // Only count static nav entries, so running games (prepended to the same array) don't shift the position
        const isStaticMenuItemElt = (e: any) => isMenuItemElt(e) && !isRunningAppRoute(e.props.route);
        const itemIndexes = menuItems.flatMap((item, index) =>
          item?.$$typeof && item.type !== "div" && isStaticMenuItemElt(item) ? index : []
        );
        if (!itemIndexes.length) {
          log("Could not find static menu items to position against.");
          return ret;
        }
        const menuItem = menuItems[itemIndexes[0]] as { props: MainMenuItemProps; type: FC<MainMenuItemProps> };

        const newItem = (
          <SpotifyMenuItem
            key="spotify"
            route={routePath}
            label="Spotify"
            onFocus={menuItem.props.onFocus}
            onGamepadFocus={menuItem.props.onGamepadFocus}
            useIconAsProp={!!menuItem.props.icon}
            MenuItemComponent={menuItem.type}
          />
        );

        const position = settings.menuPosition;
        if (position > itemIndexes.length) menuItems.splice(itemIndexes[itemIndexes.length - 1] + 1, 0, newItem);
        else menuItems.splice(itemIndexes[Math.max(position, 1) - 1], 0, newItem);

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
    menuNode.return.type = orig;
    if (menuNode.return.alternate) {
      menuNode.return.alternate.type = menuNode.return.type;
    }
  };
}

// Running game entries route to the game's page, e.g. /library/app/<appid>
function isRunningAppRoute(route: unknown) {
  return typeof route === "string" && /\/\d+(\/|$)/.test(route);
}

interface SpotifyMenuItemProps extends MainMenuItemProps {
  MenuItemComponent: FC<MainMenuItemProps>;
  useIconAsProp: boolean;
}

const SpotifyMenuItem: FC<SpotifyMenuItemProps> = ({ MenuItemComponent, useIconAsProp, ...props }) => {
  const { running } = useSpotifyState();
  const icon = <FaSpotify style={running ? { filter: "drop-shadow(rgb(30, 215, 96) 0px 0px 8px)" } : {}} />;

  return (
    <MenuItemComponent
      {...props}
      {...(useIconAsProp ? { icon } : { children: icon })}
      onSecondaryActionDescription={running ? "Close Spotify" : ""}
      onSecondaryButton={running ? () => closeSpotify() : undefined}
    />
  );
};
