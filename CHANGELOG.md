# Changelog

## 0.1.5 (2026-10-18)

- Position in Steam menu now lists a number for every spot among the entries you can see, counting other plugins' entries and leaving out entries a theme hides.
- If another plugin asks for the same spot, it keeps it and Spotify goes right below.

### Fixes

- CSS Loader themes that hide Steam menu entries (such as Main Menu Hide Tabs) hide the right entries again, wherever Spotify sits in the menu.
- Spotify opens again on the Steam Deck, where Steam's Spotify page could stay in front of it.
- Pressing the Steam button while Spotify is on screen no longer freezes Steam when the mouse pointer is near the left edge.
- After the plugin is reloaded or updated, Spotify shows up once in the Steam menu, at its saved position.

## 0.1.4 (2026-10-17)

- The Quick Access menu now mentions, under Close Spotify, that pressing X on Spotify's Steam menu entry closes it too.

## 0.1.3 (2026-10-17)

- Type into Spotify with Steam's keyboard: select a text field in Spotify, such as the search bar, press Steam + X, type in the text box that appears, and press Type. Accented letters and emoji work too.

## 0.1.2 (2026-10-16)

- Spotify's icon in the Steam menu now just turns green while Spotify is running, without a glow. The Menu icon glow setting is gone.

### Fixes

- Pressing the Steam button while Spotify is on screen no longer freezes Steam.

## 0.1.1 (2026-10-16)

- Audio Loader's menu music pauses while Spotify is running, and comes back when you close Spotify.
- Spotify's icon in the Steam menu lights up green while Spotify is running, so it's easier to spot. Adjust how brightly it glows (or turn it off) with Menu icon glow in the Quick Access menu.

### Fixes

- Updating or reloading SpotifyDeck while Spotify is on screen no longer leaves the screen stuck on Spotify.
- Spotify now stays at the Steam menu position you chose when other plugins also add menu entries, and no longer gets hidden by CSS Loader themes that hide menu entries, such as Main Menu Hide Tabs.
- Updating or reloading SpotifyDeck no longer removes other plugins' entries, such as Browser or Discord, from the Steam menu.

## 0.1.0 (2026-10-16)

- Adds Spotify to the Steam menu. Picking it opens the Spotify app installed from Discover, and starts it first if it isn't running.
- Spotify no longer needs to be added as a non-Steam game, and doesn't take up a running game slot.
- Spotify keeps playing in the background after you leave it with the Steam button, including while you play a game.
- The Steam menu and Quick Access menu open over Spotify, so you can get back to Steam at any time.
- Close Spotify by pressing X on its Steam menu entry, or with the Close Spotify button in the Quick Access menu.
- Choose where Spotify sits in the Steam menu from the Quick Access menu.
