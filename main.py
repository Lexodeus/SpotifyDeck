import asyncio
import ctypes
import json
import os
import signal

import decky

FLATPAK_APP = "com.spotify.Client"
# Gamescope only lets Steam focus windows that carry a STEAM_GAME app ID, which windows
# launched outside Steam don't have. This ID ("SPOT") is not a real Steam app.
GAMESCOPE_APP_ID = 0x53504F54
STEAM_APP_ID = 769
WINDOW_WAIT_SECONDS = 45
RUNNING_POLL_SECONDS = 3
# Time for Spotify to take keyboard focus again after it's brought back to the front
REFOCUS_DELAY = 0.3

SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

# Steam Input treats Spotify's window as app GAMESCOPE_APP_ID without its top byte
CONTROLLER_APP_ID = GAMESCOPE_APP_ID & 0xFFFFFF
LAYOUT_TITLE = "SpotifyDeck"


def load_settings() -> dict:
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(values: dict):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(values, f, indent=2)


def session_env() -> dict[str, str]:
    """Environment for talking to Steam's X display and the user's systemd session."""
    # Decky's bundled libraries leak in through LD_LIBRARY_PATH and break system binaries
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LD_", "PYTHON", "_MEI"))}
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    env["DISPLAY"] = ":0"
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin"
    # xdotool drops anything outside ASCII without a UTF-8 locale
    env["LC_ALL"] = "C.UTF-8"
    # Copy the display and session bus from Steam itself, in case they aren't the defaults
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() != "steam":
                    continue
            with open(f"/proc/{pid}/environ", "rb") as f:
                steam_env = dict(
                    item.split("=", 1) for item in f.read().decode(errors="replace").split("\0") if "=" in item
                )
        except OSError:
            continue
        for key in ("DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"):
            if key in steam_env:
                env[key] = steam_env[key]
        break
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={env['XDG_RUNTIME_DIR']}/bus")
    return env


def die_with_parent():
    """Runs in the child before exec: stop it when the backend dies, even if Decky kills the backend outright."""
    try:
        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


# Steam Input layouts are Valve KeyValues files: nested "key" "value" pairs where keys can repeat, so a block is
# kept as a list of (key, value) pairs and a value is either a string or another list.
KeyValues = list[tuple[str, "str | KeyValues"]]


def parse_keyvalues(text: str) -> KeyValues:
    tokens: list[str | None] = []  # None marks a brace, kept in order in braces
    braces: list[str] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end == -1 else end + 1
        elif c in "{}":
            tokens.append(None)
            braces.append(c)
            i += 1
        elif c == '"':
            end = text.index('"', i + 1)
            tokens.append(text[i + 1:end])
            i = end + 1
        else:
            end = i
            while end < len(text) and not text[end].isspace() and text[end] not in '{}"':
                end += 1
            tokens.append(text[i:end])
            i = end
    pos = brace = 0

    def block() -> KeyValues:
        nonlocal pos, brace
        pairs: KeyValues = []
        while pos < len(tokens):
            key = tokens[pos]
            pos += 1
            if key is None:
                if braces[brace] == "}":
                    brace += 1
                    return pairs
                raise ValueError("Block without a key")
            value = tokens[pos]
            pos += 1
            if value is None:
                if braces[brace] != "{":
                    raise ValueError("Unexpected }")
                brace += 1
                pairs.append((key, block()))
            else:
                pairs.append((key, value))
        return pairs

    return block()


def format_keyvalues(pairs: KeyValues, depth=0) -> str:
    indent = "\t" * depth
    lines = []
    for key, value in pairs:
        if isinstance(value, str):
            lines.append(f'{indent}"{key}"\t\t"{value}"')
        else:
            lines += [f'{indent}"{key}"', f"{indent}{{", format_keyvalues(value, depth + 1), f"{indent}}}"]
    return "\n".join(line for line in lines if line)


def blocks(pairs: KeyValues, key: str) -> list[KeyValues]:
    return [value for k, value in pairs if k.lower() == key.lower() and not isinstance(value, str)]


def value_of(pairs: KeyValues, key: str) -> str | None:
    return next((v for k, v in pairs if k.lower() == key.lower() and isinstance(v, str)), None)


def active_group_ids(mappings: KeyValues, source: str) -> set[str]:
    """IDs of the groups the layout's presets bind to a physical control, e.g. "dpad" or "switch"."""
    ids = set()
    for preset in blocks(mappings, "preset"):
        for bindings in blocks(preset, "group_source_bindings"):
            for group_id, value in bindings:
                if isinstance(value, str) and value.split() == [source, "active"]:
                    ids.add(group_id)
    return ids


# One activator of a button: what it presses, and its settings (e.g. a delay)
Activator = tuple[list[str], dict[str, str]]


def set_button(mappings: KeyValues, group_ids: set[str], button: str, activators: list[Activator]) -> bool:
    """Replaces what a button does in the given groups. Returns whether the button was found."""
    found = False
    for group in blocks(mappings, "group"):
        if value_of(group, "id") not in group_ids:
            continue
        for inputs in blocks(group, "inputs"):
            for binding in blocks(inputs, button):
                for current in blocks(binding, "activators"):
                    current[:] = [
                        ("Full_Press", [("bindings", [("binding", b) for b in bindings])]
                         + ([("settings", list(settings.items()))] if settings else []))
                        for bindings, settings in activators
                    ]
                    found = True
    return found


def key(name: str, label: str) -> list[Activator]:
    return [([f"key_press {name}, {label}"], {})]


# Steam presses every key of a button in the same instant and lets go of them together, and Spotify ignores a
# shortcut unless its modifier is pressed before the key and let go after it (tested on the Deck OLED). So a shortcut
# presses the key a moment after the modifier and holds the modifier a moment longer, using two activators the way
# Valve's own layouts delay one. Not interruptable: a quick tap still sends both.
SHORTCUT_DELAY_MS = "30"


def trigger(name: str, label: str) -> list[Activator]:
    """A TRIGGER_KEYS key with Ctrl+Alt+Shift. The backend only needs the modifiers held, so no delays."""
    return [([f"key_press {TRIGGER_MODIFIERS[0]}, {label}", *(f"key_press {m}" for m in TRIGGER_MODIFIERS[1:]),
              f"key_press {name}"], {})]


def shortcut(modifier: str, name: str, label: str) -> list[Activator]:
    return [
        ([f"key_press {modifier}, {label}"], {"delay_end": SHORTCUT_DELAY_MS, "interruptable": "0"}),
        ([f"key_press {name}"], {"delay_start": SHORTCUT_DELAY_MS, "interruptable": "0"}),
    ]


# Keys the layout sends for what Spotify can't do from a key press: in Spotify for Linux, Ctrl+Left/Right and
# Ctrl+Up/Down do nothing even with the timing above, and a second Ctrl+K doesn't close the search. The backend acts
# on these keys while Spotify is in front (see _watch_trigger_keys); Spotify and SteamOS ignore media keys.
# A USB or Bluetooth keyboard's keys reach X through the same device as Steam's, so the keys that don't mean what
# they say are sent with Ctrl+Alt+Shift held, which nobody presses on a keyboard by accident. Previous/Next skip
# songs from a keyboard too. (Steam sends nothing for F13-F24 on SteamOS.)
TRIGGER_MODIFIERS = ["LEFT_CONTROL", "LEFT_ALT", "LEFT_SHIFT"]
TRIGGER_STATE = 0x4 | 0x8 | 0x1  # X modifier state of Ctrl, Alt (Mod1) and Shift
# (X keysym, sent with TRIGGER_MODIFIERS): action
TRIGGER_KEYS = {
    ("XF86AudioPrev", False): "previous",  # PREV_TRACK
    ("XF86AudioNext", False): "next",  # NEXT_TRACK
    ("XF86AudioPlay", True): "volume_up",  # PLAY
    ("XF86AudioStop", True): "volume_down",  # STOP
    ("XF86AudioPrev", True): "search",  # PREV_TRACK
}
# Keys and clicks that close Spotify's search, or leave it for something else
SEARCH_CLOSING_KEYS = {"Escape", "Return", "KP_Enter"}

# What SpotifyDeck changes in Steam's Web Browser layout, by physical control and button. In Spotify, Space plays
# or pauses and Shift+Left/Right seek 5 seconds.
# Valve's A sends Enter + Space, which would play/pause each time A selects something. In Steam's layout files
# button_escape is the Menu (☰) button and button_menu is the View (⧉) button. Valve's View sends Ctrl+W, which
# does nothing in Spotify.
LAYOUT_CHANGES: dict[tuple[str, str], list[Activator]] = {
    ("button_diamond", "button_a"): key("SPACE", "Play/pause"),
    ("button_diamond", "button_y"): key("RETURN", "Enter"),
    ("switch", "left_bumper"): key("PREV_TRACK", "Previous song"),
    ("switch", "right_bumper"): key("NEXT_TRACK", "Next song"),
    ("switch", "button_escape"): trigger("PREV_TRACK", "Search"),
    ("switch", "button_menu"): key("ESCAPE", "Close popups"),
    ("dpad", "dpad_north"): trigger("PLAY", "Volume up"),
    ("dpad", "dpad_south"): trigger("STOP", "Volume down"),
    ("dpad", "dpad_west"): shortcut("LEFT_SHIFT", "LEFT_ARROW", "Back 5 seconds"),
    ("dpad", "dpad_east"): shortcut("LEFT_SHIFT", "RIGHT_ARROW", "Forward 5 seconds"),
}


# Steam only has a Web Browser layout for the Steam Deck. The Steam Controller (2026) has the same buttons and input
# names, so its layout is built from the Deck's.
WEB_BROWSER_TEMPLATES = {"controller_neptune": "controller_neptune", "controller_triton": "controller_neptune"}


def build_layout(template: str, template_url: str, url: str, steam_id: str, controller_type: str) -> str:
    """Steam's Web Browser layout, for controller_type, with the buttons in LAYOUT_CHANGES changed for Spotify."""
    (_, mappings), = parse_keyvalues(template)
    for (source, button), activators in LAYOUT_CHANGES.items():
        # Only the groups in use: the template also has an unused D-pad group for the left trackpad
        if not set_button(mappings, active_group_ids(mappings, source), button, activators):
            raise ValueError(f"Steam's Web Browser layout has changed, {button} wasn't found")
    header = {
        "title": LAYOUT_TITLE,
        "description": "Layout for Spotify, set up by SpotifyDeck",
        "creator": steam_id,
        "progenitor": template_url,
        "url": url,
        "export_type": "unknown",
    }
    body = [(k, v) for k, v in mappings if k.lower() not in header and k.lower() != "localization"]
    body = [(k, controller_type if k == "controller_type" else v) for k, v in body]
    version = [(k, v) for k, v in body[:1] if k == "version"]
    mappings[:] = version + list(header.items()) + body[len(version):]
    return format_keyvalues([("controller_mappings", mappings)]) + "\n"


def steam_dir() -> str:
    return os.path.join(decky.DECKY_USER_HOME, ".local", "share", "Steam")


def layout_path(steam_id: str, serial: str) -> str:
    # Steam keeps the layout picked for an app per controller, in a file named after the controller's serial number
    account_id = int(steam_id) - 76561197960265728
    return os.path.join(steam_dir(), "steamapps", "common", "Steam Controller Configs", str(account_id), "config",
                        str(CONTROLLER_APP_ID), f"{serial}.vdf")


def layout_title(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            (_, mappings), = parse_keyvalues(f.read())
        return value_of(mappings, "title")
    except (OSError, ValueError):
        return None


async def run(*args: str, stdin: str | None = None) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, env=session_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate(stdin.encode() if stdin is not None else None)
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def is_running() -> bool:
    _, out = await run("flatpak", "ps", "--columns=application")
    return FLATPAK_APP in out.split()


async def read_root_cardinals(prop: str) -> list[int]:
    _, out = await run("xprop", "-root", prop)
    return parse_cardinals(out)


def parse_cardinals(xprop_line: str) -> list[int]:
    if "=" not in xprop_line:
        return []
    return [int(v) for v in xprop_line.split("=", 1)[1].replace(" ", "").split(",") if v.isdigit()]


async def park_pointer() -> tuple[int, int] | None:
    """
    Moves the mouse pointer to the bottom-right corner, where Steam keeps it, and returns where it was.
    Steam's menu opens at the left edge of the screen. If the pointer is still over that spot when Spotify steps
    aside, the menu and Steam's main window fight over keyboard focus and Steam's UI hangs.
    """
    try:
        _, location = await run("xdotool", "getmouselocation", "--shell")
        values = dict(line.split("=", 1) for line in location.splitlines() if "=" in line)
        _, size = await run("xdotool", "getdisplaygeometry")
        width, height = (int(v) for v in size.split())
        await run("xdotool", "mousemove", str(width - 1), str(height - 1))
        return int(values["X"]), int(values["Y"])
    except Exception:
        decky.logger.exception("Couldn't move the mouse pointer out of the way")
        return None


async def is_top_level(window: int) -> bool:
    _, out = await run("xwininfo", "-tree", "-id", str(window))
    parent = next((line for line in out.splitlines() if line.strip().startswith("Parent window id:")), "")
    return "(the root window)" in parent


async def set_root_window_focus(window: int):
    await run("xprop", "-root", "-f", "GAMESCOPECTRL_BASELAYER_WINDOW", "32c",
              "-set", "GAMESCOPECTRL_BASELAYER_WINDOW", str(window))


# Prints "key <keysym> <modifier state>" for each key press on Steam's X display that's in argv, "release <keysym>"
# when it's let go, and "click" for each mouse click, using the XRecord extension. Run with the system Python as its own process (see watch_trigger_keys).
KEY_WATCHER = r"""
import ctypes, sys
X = ctypes.CDLL("libX11.so.6"); Xtst = ctypes.CDLL("libXtst.so.6")
X.XOpenDisplay.restype = ctypes.c_void_p; X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XKeycodeToKeysym.restype = ctypes.c_ulong; X.XKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int]
X.XKeysymToString.restype = ctypes.c_char_p; X.XKeysymToString.argtypes = [ctypes.c_ulong]
class R8(ctypes.Structure): _fields_ = [("first", ctypes.c_ubyte), ("last", ctypes.c_ubyte)]
class R16(ctypes.Structure): _fields_ = [("first", ctypes.c_ushort), ("last", ctypes.c_ushort)]
class Ext(ctypes.Structure): _fields_ = [("major", R8), ("minor", R16)]
class Range(ctypes.Structure):
    _fields_ = [("core_requests", R8), ("core_replies", R8), ("ext_requests", Ext), ("ext_replies", Ext),
                ("delivered_events", R8), ("device_events", R8), ("errors", R8),
                ("client_started", ctypes.c_int), ("client_died", ctypes.c_int)]
class Data(ctypes.Structure):
    _fields_ = [("id_base", ctypes.c_ulong), ("server_time", ctypes.c_ulong), ("client_seq", ctypes.c_ulong),
                ("category", ctypes.c_int), ("client_swapped", ctypes.c_int),
                ("data", ctypes.POINTER(ctypes.c_ubyte)), ("data_len", ctypes.c_ulong)]
Xtst.XRecordAllocRange.restype = ctypes.POINTER(Range)
Xtst.XRecordCreateContext.restype = ctypes.c_ulong
Xtst.XRecordCreateContext.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int,
                                      ctypes.POINTER(ctypes.POINTER(Range)), ctypes.c_int]
Callback = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.POINTER(Data))
Xtst.XRecordEnableContext.argtypes = [ctypes.c_void_p, ctypes.c_ulong, Callback, ctypes.c_void_p]
Xtst.XRecordFreeData.argtypes = [ctypes.POINTER(Data)]
wanted = set(sys.argv[1:])
control, data = X.XOpenDisplay(None), X.XOpenDisplay(None)
if not control or not data:
    sys.exit("Can't open the X display")
ranges = Xtst.XRecordAllocRange()
ranges.contents.device_events.first, ranges.contents.device_events.last = 2, 4  # KeyPress to ButtonPress
all_clients = ctypes.c_ulong(3)
context = Xtst.XRecordCreateContext(control, 0, ctypes.byref(all_clients), 1, ctypes.byref(ranges), 1)
X.XSync(control, 0)
def on_event(_, record):
    event = record.contents
    if event.category == 0 and event.data:  # From the server
        kind, detail = event.data[0], event.data[1]
        if kind in (2, 3):
            name = X.XKeysymToString(X.XKeycodeToKeysym(control, detail, 0))
            state = event.data[28] | (event.data[29] << 8)
            if name and name.decode() in wanted:
                print("key" if kind == 2 else "release", name.decode(), state, flush=True)
        elif kind == 4 and detail in (1, 2, 3):  # Not the scroll wheel
            print("click", flush=True)
    Xtst.XRecordFreeData(record)
callback = Callback(on_event)
print("ready", flush=True)
Xtst.XRecordEnableContext(data, context, callback, None)  # Blocks until the display goes away
"""

MPRIS = ("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player")
VOLUME_STEP = 0.1


class Plugin:
    launching = False
    shown_window: int | None = None
    error: str | None = None

    # Where the mouse pointer was in Spotify before it was parked for Steam
    pointer: tuple[int, int] | None = None

    # Spotify window stepped aside while a Steam menu, modal, keyboard or the text box is open
    lowered_window: int | None = None
    steam_overlay_open = False

    # Text from the plugin's text box, typed into Spotify once it's back in front
    pending_text: str | None = None

    # Whether Spotify's search, opened with Menu, is still open (as far as the keys and clicks tell)
    search_open = False
    # Menu's key is down: search opens or closes once it's let go
    search_pressed = False

    async def _main(self):
        self.lock = asyncio.Lock()
        self.show_task: asyncio.Task | None = None
        self.watch_task: asyncio.Task | None = None
        async with self.lock:
            await self._release_stale_windows()
        self.trigger_task = asyncio.create_task(self._watch_trigger_keys())
        await self._watch_running()

    async def _watch_running(self):
        """Tells the frontend when Spotify starts or quits, including from outside the plugin."""
        was_running = None
        while True:
            running = await is_running()
            if running != was_running:
                if was_running is not None:
                    await self.emit_state()
                was_running = running
            await asyncio.sleep(RUNNING_POLL_SECONDS)

    async def _watch_trigger_keys(self):
        """Acts on the keys SpotifyDeck's controller layout sends for what Spotify has no working key for."""
        names = {name for name, _ in TRIGGER_KEYS} | SEARCH_CLOSING_KEYS
        while True:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "python3", "-I", "-c", KEY_WATCHER, *names, env=session_env(), stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, preexec_fn=die_with_parent,
                )
                try:
                    async for line in proc.stdout:
                        await self._on_watched_input(line.decode(errors="replace").split())
                finally:
                    if proc.returncode is None:
                        proc.terminate()
                    await proc.wait()
                decky.logger.warning(f"The controller key watcher stopped ({proc.returncode}), restarting it")
            except asyncio.CancelledError:
                raise
            except Exception:
                decky.logger.exception("The controller key watcher failed, restarting it")
            # E.g. while Steam restarts and its X display is away
            await asyncio.sleep(5)

    async def _on_watched_input(self, words: list[str]):
        if words == ["ready"]:
            decky.logger.info("Watching for SpotifyDeck's controller keys")
            return
        if words == ["click"] or (words[:1] == ["key"] and words[1] in SEARCH_CLOSING_KEYS):
            self.search_open = False
            return
        if words[:1] == ["release"] and self.search_pressed:
            # Steam holds Ctrl+Alt+Shift as long as Menu is down, and Spotify ignores Ctrl+K with Alt and Shift
            self.search_pressed = False
            if self.shown_window is not None:
                await self._toggle_search()
            return
        if words[:1] != ["key"] or len(words) < 3 or self.shown_window is None:
            return
        with_modifiers = int(words[2]) & TRIGGER_STATE == TRIGGER_STATE
        action = TRIGGER_KEYS.get((words[1], with_modifiers))
        try:
            if action == "previous":
                await run("busctl", "--user", "call", *MPRIS, "Previous")
            elif action == "next":
                await run("busctl", "--user", "call", *MPRIS, "Next")
            elif action in ("volume_up", "volume_down"):
                _, out = await run("busctl", "--user", "get-property", *MPRIS, "Volume")
                volume = float(out.split()[-1])
                volume += VOLUME_STEP if action == "volume_up" else -VOLUME_STEP
                volume = round(min(1.0, max(0.0, volume)), 2)
                await run("busctl", "--user", "set-property", *MPRIS, "Volume", "d", str(volume))
            elif action == "search":
                self.search_pressed = True
        except Exception:
            decky.logger.exception(f"Couldn't {action} in Spotify")

    async def _toggle_search(self):
        try:
            if self.search_open:
                await run("xdotool", "key", "Escape")
                self.search_open = False
            else:
                # Spotify ignores the shortcut when Ctrl comes in together with K or goes away with it
                await run("xdotool", "keydown", "Control_L", "sleep", "0.03", "key", "k", "sleep", "0.03",
                          "keyup", "Control_L")
                self.search_open = True
        except Exception:
            decky.logger.exception("Couldn't open or close Spotify's search")

    async def _unload(self):
        if getattr(self, "trigger_task", None):
            self.trigger_task.cancel()
        # Decky may stop the backend before a full hide() finishes, so give the screen back to Steam first
        if self.shown_window is not None:
            await park_pointer()
            await set_root_window_focus(0)
        await self.hide()

    async def _release_stale_windows(self):
        """Releases windows a previous run left tagged, e.g. when Decky stopped it before it could clean up."""
        if self.shown_window is not None:
            return
        focused = await read_root_cardinals("GAMESCOPECTRL_BASELAYER_WINDOW")
        focusable = await read_root_cardinals("GAMESCOPE_FOCUSABLE_WINDOWS")
        # Triplets of window, app ID, pid
        for window, app_id in zip(focusable[0::3], focusable[1::3]):
            if app_id != GAMESCOPE_APP_ID:
                continue
            if focused == [window]:
                await park_pointer()
                await set_root_window_focus(0)
            await run("xprop", "-id", str(window), "-remove", "STEAM_GAME")
            decky.logger.info(f"Released Spotify window {window} left over from a previous run")

    async def get_state(self) -> dict:
        installed = (await run("flatpak", "info", FLATPAK_APP))[0] == 0
        return {
            "installed": installed,
            "running": await is_running(),
            "launching": self.launching,
            "shown": self.shown_window is not None,
            "error": self.error,
        }

    async def get_setting(self, key: str, default):
        return load_settings().get(key, default)

    async def set_setting(self, key: str, value):
        values = load_settings()
        values[key] = value
        save_settings(values)

    async def prepare_layout(self, steam_id: str, serial: str, controller_type: str, replace: bool) -> dict:
        """
        Writes SpotifyDeck's controller layout for one controller, and returns its URL to select it with.
        A layout file that's already there is kept, so changes made to it in Steam stay. One with another title is
        a different layout, saved by Steam for this controller: it's only replaced with replace set, and otherwise
        its title is returned instead of a URL.
        """
        path = layout_path(steam_id, serial)
        url = f"autosave://{path}"
        if os.path.exists(path):
            title = layout_title(path)
            if title == LAYOUT_TITLE:
                return {"url": url, "title": title}
            if not replace:
                return {"url": None, "title": title}
        if controller_type not in WEB_BROWSER_TEMPLATES:
            raise ValueError(f"No Web Browser layout to start from for {controller_type}")
        template_name = f"{WEB_BROWSER_TEMPLATES[controller_type]}_webbrowser.vdf"
        with open(os.path.join(steam_dir(), "controller_base", "templates", template_name), encoding="utf-8") as f:
            layout = build_layout(f.read(), f"template://{template_name}", url, steam_id, controller_type)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(layout)
        os.replace(path + ".tmp", path)
        decky.logger.info(f"Wrote the controller layout {path}")
        return {"url": url, "title": LAYOUT_TITLE}

    async def show(self):
        """Bring Spotify to the front, launching it first if needed."""
        if self.show_task and not self.show_task.done():
            return
        self.show_task = asyncio.create_task(self._show())

    async def hide(self):
        """Hand the screen back to Steam. Spotify keeps running (and playing) in the background."""
        if self.show_task and not self.show_task.done():
            self.show_task.cancel()
        async with self.lock:
            self.steam_overlay_open = False
            self.lowered_window = None
            self.pending_text = None
            await self._unfocus()
        await self.emit_state()

    async def set_steam_overlay_open(self, is_open: bool):
        """
        With no game running, Steam draws its menus, modals and keyboard inside its own window,
        which is underneath Spotify. Step Spotify aside while they're open.
        """
        async with self.lock:
            self.steam_overlay_open = is_open
            if is_open and self.shown_window is not None:
                window = self.shown_window
                await self._unfocus(keep_watching=True)
                self.lowered_window = window
            elif not is_open and self.lowered_window is not None:
                window, self.lowered_window = self.lowered_window, None
                if await self._find_window() == window:
                    await self._focus(window)
            await self._type_pending_text()
        await self.emit_state()

    async def send_text(self, text: str):
        """
        Type text into Spotify's selected text field, as soon as Spotify is back in front.
        No Enter afterwards: Spotify's search shows results as you type, and Enter in its quick search
        opens whichever result is on top, which may not have caught up with the text yet.
        """
        text = " ".join(text.splitlines()).strip()
        if not text:
            return
        async with self.lock:
            self.pending_text = text
            await self._type_pending_text()

    async def close(self):
        await self.hide()
        await run("flatpak", "kill", FLATPAK_APP)
        await self.emit_state()

    async def emit_state(self):
        await decky.emit("state", await self.get_state())

    async def _show(self):
        self.error = None
        try:
            window = await self._find_window()
            if window is None:
                self.launching = True
                await self.emit_state()
                await self._launch()
                window = await self._wait_for_window()
            async with self.lock:
                if self.steam_overlay_open:
                    self.lowered_window = window
                else:
                    await self._focus(window)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            decky.logger.exception("Failed to show Spotify")
            self.error = str(e)
        finally:
            self.launching = False
            await self.emit_state()

    async def _launch(self):
        env = session_env()
        decky.logger.info(f"Launching {FLATPAK_APP} on {env['DISPLAY']}")
        # Run it in the user's systemd session so it outlives the plugin and Decky restarts
        code, out = await run(
            "systemd-run", "--user", "--collect", "--quiet",
            *(f"--setenv={k}={env[k]}" for k in ("DISPLAY", "XAUTHORITY") if k in env),
            "flatpak", "run", FLATPAK_APP,
        )
        if code != 0:
            raise RuntimeError(f"Couldn't start Spotify: {out}")

    async def _find_window(self) -> int | None:
        # Spotify also has a 10x10 unmapped leader window; --onlyvisible leaves out that one.
        # It can also draw into a visible child window inside its main one, and gamescope only shows
        # top-level windows, so keep the windows whose parent is the root window.
        _, out = await run("xdotool", "search", "--onlyvisible", "--class", "^Spotify$")
        windows = [int(w) for w in out.split() if w.isdigit()]
        top_level = [w for w in windows if await is_top_level(w)]
        return top_level[-1] if top_level else None

    async def _wait_for_window(self) -> int:
        for _ in range(WINDOW_WAIT_SECONDS * 2):
            window = await self._find_window()
            if window is not None:
                return window
            await asyncio.sleep(0.5)
        raise RuntimeError("Spotify started, but its window never appeared")

    async def _type_pending_text(self):
        """Types the pending text if Spotify is in front. Call with the lock held."""
        if self.pending_text is None or self.shown_window is None:
            return
        text, self.pending_text = self.pending_text, None
        await asyncio.sleep(REFOCUS_DELAY)
        # Typed through XTEST into whatever has keyboard focus, which is the window gamescope focused
        await run("xdotool", "type", "--delay", "12", "--file", "-", stdin=text)

    async def _focus(self, window: int):
        await run("xprop", "-id", str(window), "-f", "STEAM_GAME", "32c", "-set", "STEAM_GAME", str(GAMESCOPE_APP_ID))
        await set_root_window_focus(window)
        self.shown_window = window
        if self.pointer:
            await run("xdotool", "mousemove", *map(str, self.pointer))
            self.pointer = None
        decky.logger.info(f"Showing Spotify window {window}")
        if not self.watch_task or self.watch_task.done():
            self.watch_task = asyncio.create_task(self._watch_steam_focus())

    async def _unfocus(self, keep_watching=False):
        if not keep_watching and self.watch_task and not self.watch_task.done():
            self.watch_task.cancel()
        window, self.shown_window = self.shown_window, None
        if window is None:
            return
        if await read_root_cardinals("GAMESCOPECTRL_BASELAYER_WINDOW") == [window]:
            self.pointer = await park_pointer()
            await set_root_window_focus(0)
        await run("xprop", "-id", str(window), "-remove", "STEAM_GAME")
        decky.logger.info(f"Hid Spotify window {window}")

    async def _watch_steam_focus(self):
        """Steps aside when Steam brings a game to the front, e.g. when it's resumed from the Steam menu."""
        proc = await asyncio.create_subprocess_exec(
            "xprop", "-root", "-spy", "GAMESCOPECTRL_BASELAYER_APPID",
            env=session_env(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            preexec_fn=die_with_parent,
        )
        try:
            assert proc.stdout
            # The first line is the current value
            last = parse_cardinals((await proc.stdout.readline()).decode())
            while line := await proc.stdout.readline():
                app_ids = parse_cardinals(line.decode())
                if app_ids == last:
                    continue
                last = app_ids
                if app_ids and app_ids[0] != STEAM_APP_ID:
                    decky.logger.info(f"Steam focused app {app_ids[0]}, hiding Spotify")
                    async with self.lock:
                        self.watch_task = None
                        self.lowered_window = None
                        self.pending_text = None
                        await self._unfocus()
                    await self.emit_state()
                    return
        finally:
            if proc.returncode is None:
                proc.kill()
