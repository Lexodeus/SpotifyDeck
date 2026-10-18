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


async def set_root_window_focus(window: int):
    await run("xprop", "-root", "-f", "GAMESCOPECTRL_BASELAYER_WINDOW", "32c",
              "-set", "GAMESCOPECTRL_BASELAYER_WINDOW", str(window))


class Plugin:
    launching = False
    shown_window: int | None = None
    error: str | None = None

    # Spotify window stepped aside while a Steam menu, modal, keyboard or the text box is open
    lowered_window: int | None = None
    steam_overlay_open = False

    # Text from the plugin's text box, typed into Spotify once it's back in front
    pending_text: str | None = None

    async def _main(self):
        self.lock = asyncio.Lock()
        self.show_task: asyncio.Task | None = None
        self.watch_task: asyncio.Task | None = None
        async with self.lock:
            await self._release_stale_windows()
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

    async def _unload(self):
        # Decky may stop the backend before a full hide() finishes, so give the screen back to Steam first
        if self.shown_window is not None:
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
        # Spotify also has a 10x10 unmapped leader window; --onlyvisible leaves just the main one
        _, out = await run("xdotool", "search", "--onlyvisible", "--class", "^Spotify$")
        windows = [int(w) for w in out.split() if w.isdigit()]
        return windows[-1] if windows else None

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
