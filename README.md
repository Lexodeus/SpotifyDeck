# SpotifyDeck

Adds **Spotify** to the Steam menu in Gaming Mode. It opens the Spotify flatpak (`com.spotify.Client`, installed from Discover in Desktop Mode) without adding it to your library as a non-Steam game.

![Spotify in the Steam menu, with its icon green while Spotify is running](assets/screenshot.png)

- Pick **Spotify** in the Steam menu to open it. It starts Spotify first if it isn't running yet.
- Press the Steam button and pick anything else to go back to Steam. Spotify keeps playing in the background.
- Press Steam + X while Spotify is open to type with Steam's keyboard. Select the text field in Spotify first, such as the search bar, then type in the text box that appears and press Type.
- Highlight Spotify in the Steam menu and press X to close it, or use Close Spotify in the Quick Access menu.
- While Spotify runs, its icon in the Steam menu turns green, and Audio Loader's menu music pauses.

![The Spotify app open full screen in Gaming Mode](assets/spotify.png)

## Installation

You need:

- [Decky Loader](https://decky.xyz) 3 or newer
- Spotify (Flathub `com.spotify.Client`)

1. If you don't have Decky Loader yet, switch to Desktop Mode (Steam button → Power → Switch to Desktop), download the installer from [decky.xyz](https://decky.xyz) and run it.
2. In Desktop Mode, open Discover, search for Spotify and install it.
3. Still in Desktop Mode, open Spotify and log in to your account. Logging in is easier with a mouse and keyboard here than in Gaming Mode, and the plugin opens Spotify already logged in.
4. Maximize Spotify's window before you close it. Spotify remembers its window size, and a maximized window fills the screen properly in Gaming Mode.
5. Download `SpotifyDeck.zip` from the [latest release](https://github.com/Lexodeus/SpotifyDeck/releases/latest), then switch back to Gaming Mode.
6. Open the Quick Access menu (the … button), go to Decky and select the gear icon. Under **General**, turn on **Developer mode**.
7. Open the **Developer** tab that appears, select **Install Plugin from ZIP File** and pick `SpotifyDeck.zip`.

Spotify now shows up in the Steam menu.

## Getting around in Spotify

SpotifyDeck sets up a controller layout for Spotify when you install it, so there's nothing to set up on a Steam Deck. The buttons do this in Spotify:

| Button | In Spotify |
| --- | --- |
| A | Play / pause |
| L1 / R1 | Previous / next song |
| D-pad left / right | Back / forward 5 seconds |
| D-pad up / down | Spotify's volume up / down |
| Right trackpad or right stick | Move the pointer. Press it down to click. |
| R2 / L2 | Click / right-click |
| Left stick or left trackpad | Scroll |
| Y | Enter |
| B | Back |
| X | Type with Steam's keyboard, e.g. into the search bar |
| Menu (☰) | Open Spotify's search to find a song, artist or playlist by typing its name. Press it again to close it. |
| View (⧉) | Escape: closes popups and menus |
| L4 / R4 | Middle click / hold Ctrl |

**Controller buttons** in the Quick Access menu shows this list. Select **Edit layout in Steam** there to change a button; SpotifyDeck keeps your changes. If you switch Spotify to another layout in Steam, SpotifyDeck leaves your choice alone, and **Use SpotifyDeck's layout** in the same list switches back.

The layout is only made for the Steam Deck's own controls. With another controller, pick a layout for Spotify in Steam, or use a mouse:

- **Mouse:** plug in a USB mouse or pair a Bluetooth mouse, and use it like on a desktop.
- **Typing:** select a text field, such as the search bar, then press Steam + X (see above). A USB or Bluetooth keyboard also types straight into Spotify.

## Quick Access menu

![SpotifyDeck in the Quick Access menu](assets/quick-access.png)

- **Controller buttons**: what each button does in Spotify, and the controller layout Spotify uses (see above).
- **Close Spotify** (shown while Spotify is running). Highlighting Spotify in the Steam menu and pressing X closes it too.
- **Position in Steam menu**: where Spotify sits, numbered from the top among the entries you can see (other plugins' entries count, entries a theme hides don't). If another plugin asks for the same spot (with the same menu code as SpotifyDeck), it goes first and Spotify goes right below it.

## How it works

Gaming Mode's compositor (gamescope) only shows windows that belong to an app Steam launched. The plugin's backend starts Spotify in your user session and tags its window with a placeholder app ID. While Steam is on the plugin's Spotify page, the backend asks gamescope to show that window. When Steam navigates away, or brings a game to the front, it hands the screen back to Steam.

Steam's on-screen keyboard only types into Steam's own UI, so the plugin shows a text box on Steam's page instead and types the text into Spotify with `xdotool`.

The controller layout is Steam's Web Browser layout with some buttons changed. Spotify for Linux ignores its own shortcuts for skipping songs and changing its volume when they come from a key press, so for those buttons (and Menu) the layout sends media keys, which Spotify and SteamOS ignore. While Spotify is in front, the plugin's backend watches for those keys and tells Spotify what to do over MPRIS, Linux's standard media player interface. Keys that don't mean what they say (volume and search) are sent with Ctrl+Alt+Shift held, so the media keys of a USB or Bluetooth keyboard keep doing what they normally do.

## Privacy

SpotifyDeck is only a container for the Spotify app. It starts Spotify and shows its window in Gaming Mode; you log in and listen in Spotify itself, and SpotifyDeck never sees your account or password.

SpotifyDeck doesn't store or send your data or credentials anywhere, and it makes no network connections of its own. The only things it saves are its own settings (Spotify's position in the Steam menu, and which controllers already got its layout) and its controller layout for Spotify, on your device. Text you type with Steam + X is typed straight into Spotify and isn't saved or logged. To act on its controller buttons, the backend watches for the handful of keys its layout sends (plus Escape, Enter and mouse clicks, to know when Spotify's search closes); it ignores every other key and doesn't record or save anything.

## Credits

The Steam menu patch is adapted from [DeckWebBrowser](https://github.com/jessebofill/DeckWebBrowser) by Jesse Bofill (GPL-3.0).

## License

GPL-3.0
