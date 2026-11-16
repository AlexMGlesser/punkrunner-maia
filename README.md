# punkrunner-maia
Netrunner and map app for Maia (I better get some crazy RH after this)

A LAN tactical-map app: the host builds scenes (map image + grid + enemies + cameras with sight cones and patrol paths) and players on the same network watch them live.

## Quick start (no install)
1. **[Download PunkRunner.exe](https://github.com/AlexMGlesser/punkrunner-maia/releases/latest/download/PunkRunner.exe)**
2. Double-click it. Your browser opens to the app.
   - SmartScreen warning → **More info** → **Run anyway** (the exe isn't code-signed).
   - Firewall prompt → allow on **Private networks** so players can connect.
3. Click **Create**, then give the code and the `Network:` address shown in the black window to your players.
   Players just open that address in any browser on the same Wi-Fi. They don't need the exe.

Keep the black window open while playing; closing it shuts the session down.

### Or download from the command line
PowerShell:
```powershell
Invoke-WebRequest https://github.com/AlexMGlesser/punkrunner-maia/releases/latest/download/PunkRunner.exe -OutFile PunkRunner.exe; .\PunkRunner.exe
```
Command Prompt (curl ships with Windows 10/11):
```bat
curl -L -o PunkRunner.exe https://github.com/AlexMGlesser/punkrunner-maia/releases/latest/download/PunkRunner.exe && PunkRunner.exe
```
Both download the latest exe into the current folder and start it.

## Run from source (development)
```
npm install
npm start
```
Open http://localhost:3000. The console prints the `Network:` URL(s) other devices on your Wi-Fi should use.

## Build a shareable Windows .exe
```
npm run build
```
Produces `dist/PunkRunner.exe` (~90 MB, includes Node — recipients need nothing installed).
Double-clicking it starts the server and opens the browser. Saved scenes go in a
`punkrunner-data/` folder created next to the exe.

When sharing:
- Windows SmartScreen will warn because the exe is unsigned → "More info" → "Run anyway".
- On first run Windows Firewall asks for network access → allow on **Private networks** so players can connect.
- Players open the host's `Network:` URL (e.g. `http://192.168.1.20:3000`) in a browser — they don't need the exe.

## LAN only
The server refuses any HTTP/socket connection that doesn't come from loopback or a private
network address (10.x, 172.16–31.x, 192.168.x, link-local). Players must be on the same network as the host.

## Using it
- **Menu**: *Name* sets your handle · *Create* starts a session and shows a 5-character code · *Join* enters a code.
- **Host**: import images as scenes (button or drag-and-drop), switch scenes via the tabs, move/scale the grid
  (Grid tool + panel), place enemies (yellow circles) and cameras (rectangles), draw colored boxes, draw patrol paths and set speeds,
  toggle alert (orange cone, 1.5× range), turn a camera's sight cone off, shrink/grow all units with *Unit size*, and save scenes to the library for future sessions.
  The *Group view* dropdown puts all players in the waiting room or on a scene. The *Crew* panel overrides
  that per player: give someone their own scene (split the crew across scenes), or cut their feed to hide the view.
  Scene tabs show how many players are watching each one.
- **Everyone** can run/pause the simulation.

Keys (host): `V` select · `E` enemy · `C` camera · `B` box · `P` path · `G` grid · `H` pan · `F` fit · `A` alert · `Del` delete.
Right-drag or Space+drag pans, the mouse wheel zooms.
