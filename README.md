# Ligma

An unofficial Figma client for Linux: figma.com in its own window, with tabs, WebGPU rendering and your locally installed fonts.

> Ligma is not affiliated with, endorsed by, or supported by Figma, Inc. "Figma" is a trademark of Figma, Inc.

## Install

Download the latest build from [Releases](https://github.com/jun0p3r/ligma/releases):

| Package | For |
| --- | --- |
| `Ligma-<version>-amd64.deb` | Ubuntu, Debian, Mint, Pop!_OS (recommended on Ubuntu, see below) |
| `Ligma-<version>-x86_64.rpm` | Fedora, RHEL, openSUSE |
| `Ligma-<version>-x86_64.flatpak` | Any distro with Flatpak |
| `Ligma-<version>-x86_64.AppImage` | Any distro, ideally installed with Gear Lever |

Install only one of them; they all add the same app-menu entry.

### Ubuntu / Debian (.deb)

```bash
sudo apt install ./Ligma-0.1.0-amd64.deb
```

On Ubuntu 23.10 and newer, the AppImage has to run without Chromium's sandbox because Ubuntu restricts unprivileged user namespaces. The .deb installs an AppArmor profile for Ligma so the sandbox stays on.

### Fedora / RHEL / openSUSE (.rpm)

```bash
sudo dnf install ./Ligma-0.1.0-x86_64.rpm        # Fedora, RHEL
sudo zypper install ./Ligma-0.1.0-x86_64.rpm     # openSUSE
```

### Flatpak

```bash
flatpak install --user ./Ligma-0.1.0-x86_64.flatpak
```

Flatpak installs the runtime Ligma needs from Flathub if it's missing, so make sure the Flathub remote is set up. The Flatpak sees your system and `~/.local/share/fonts` fonts automatically, and can save downloads to your Downloads folder. Its data lives in `~/.var/app/io.github.jun0p3r.Ligma/`.

### AppImage with Gear Lever

Ligma ships as a single AppImage. [Gear Lever](https://flathub.org/apps/details/it.mijorus.gearlever) is the easiest way to install it: it adds Ligma to your app menu with its icon, keeps your AppImages in one folder, and handles updates and removal.

1. Install Gear Lever from Flathub:

   ```bash
   flatpak install flathub it.mijorus.gearlever
   ```

2. Open `Ligma-0.1.0-x86_64.AppImage` with Gear Lever: drag it onto the Gear Lever window, or right-click it in your file manager and choose **Open With → Gear Lever**.
3. Confirm adding it to your app menu. Ligma then appears in your app launcher like any other app.

From a terminal instead:

```bash
flatpak run it.mijorus.gearlever --integrate ~/Downloads/Ligma-0.1.0-x86_64.AppImage
```

To uninstall, remove it in Gear Lever (or use `flatpak run it.mijorus.gearlever --remove`). Your login and window state live in `~/.config/Ligma` and are kept unless you delete that folder.

### Without Gear Lever

```bash
chmod +x Ligma-0.1.0-x86_64.AppImage
./Ligma-0.1.0-x86_64.AppImage
```

The AppImage uses the static AppImage runtime, so it does **not** need `libfuse2`.

## Signing in

Sign in with your Figma **email and password**.

Google sign-in isn't available: Google doesn't allow signing in from apps that embed a web browser, and Ligma doesn't disguise itself to get around that. If your Figma account was created with Google, use **Forgot password?** on Figma's login page to set a password, then sign in with it. (Organizations that enforce Google SSO may not allow this.) Your session is remembered between launches.

## Features

- **Tabs** – Home (your files) is always the first tab; each file opens in its own tab, and opening a file that's already open switches to it. Open tabs are restored on the next launch and load when you first click them.

  | Shortcut | Action |
  | --- | --- |
  | Ctrl+T | New tab |
  | Ctrl+W / middle-click | Close tab |
  | Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgUp/PgDn | Switch tabs |
  | Ctrl+R / F5 | Reload |
  | F11 | Fullscreen |
  | F12 / Ctrl+Shift+I | Developer tools |

- **Draggable title bar** – drag empty space in the tab bar to move the window; double-click it to maximize.
- **Local fonts** – Ligma runs a built-in font helper (compatible with Figma's font agent) on `127.0.0.1:44950` that offers your fontconfig fonts, including variable-font axes, to Figma's font picker. It only answers figma.com and only serves font files found by the scan. If you already run [figma-agent-linux](https://github.com/neetly/figma-agent-linux), Ligma uses that instead.
- **WebGPU** – Figma's WebGPU renderer is used on supported GPUs, with zero-copy canvas presentation.
- Links outside Figma open in your default browser.

## Troubleshooting

Gear Lever launches Ligma from the app menu; to use the options below, run the AppImage from a terminal.

- **Check GPU status:** `./Ligma-0.1.0-x86_64.AppImage --gpu-debug` opens Chromium's GPU page. "WebGPU: Hardware accelerated" means it's working.
- **Rendering glitches:** `LIGMA_NO_WEBGPU=1 ./Ligma-0.1.0-x86_64.AppImage` makes Figma fall back to WebGL.
- **WebGPU not detected** on an unusual GPU/driver: `LIGMA_FORCE_WEBGPU=1 ./Ligma-0.1.0-x86_64.AppImage`.
- **Fonts missing from the picker:** make sure nothing else is using port 44950, and check Figma's *Preferences → Permissions and helpers*. Newly installed fonts are picked up automatically.
- **Sandbox:** the AppImage keeps Chromium's sandbox on when your system allows unprivileged user namespaces. Where it doesn't (Ubuntu 23.10+, hardened kernels), it starts without the sandbox rather than failing to launch. On Ubuntu, use the .deb to keep the sandbox.
- **Bugs and feature requests:** [GitHub issues](https://github.com/jun0p3r/ligma/issues).

## Building from source

Requires Node.js 24 or newer. Building the .rpm needs `rpmbuild` (`rpm` package) and the Flatpak needs `flatpak-builder`; build a single format with e.g. `npx electron-builder --linux deb`.

```bash
npm install
npm start          # run from source
npm run dist       # build the AppImage, .deb, .rpm and .flatpak into dist/
```

`ligma.sh` runs the source checkout (it adds a user-local Node install at `~/.local/opt/node` to `PATH`).
