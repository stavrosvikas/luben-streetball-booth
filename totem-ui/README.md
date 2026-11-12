# Totem UI (booth2)

This is the booth screen that runs on the totem at the event. It uses Stavros's design from `booth-v3.html`, but the logic is Bright's booth logic. A copy also lives in the Luben Streetball scoreboard app, where it is served as `/booth2`.

## Flow
1. **Idle:** pick a filter, then press **ΤΡΑΒΑ**. A USB button works too, because it sends Space or Enter.
2. A 5…1 countdown runs, then the totem records for 3 seconds.
3. The raw clip is uploaded to the booth server, which renders the filter.
4. A small QR appears bottom-left over the clip as it plays. The finished clip replaces the raw one as soon as the server has it.
5. **ΕΠΟΜΕΝΟΣ** (top-right) brings the idle screen back. There is no timer by default, so people have time to scan.

## The filters run on the server, not on the totem
The totem has 2 GB of RAM, which is too little for RVM matting. So the server opens `booth-v3.html` in headless Chrome and feeds it the clip as 432×768 frames, then encodes the result at 1080×1920. The output uses the same timing and logo as in this repo, so whatever changes in `booth-v3.html` shows up in the clips once the new version is copied to the server.

Filter keys (`&fx=` in the URL, and the order of the buttons): `ghost, quake, rgb, sticker, onfire, card`.
- `onfire` is **FLAME OUTLINE**, followed by a hard cut to the Vangelis Ioannou reaction «YOU WERE ON FIRE MY MAN», with sound. The server adds the reaction with ffmpeg.
- `flame` (FLAME OUTLINE without the reaction) also exists, but it is not shown by default.

## Server calls
All URLs are relative to the page:
- `POST api/booth/upload?id=<id>&rot=<deg>&look=replay&fx=<key>`: the raw clip as the request body (MP4/H.264 or WebM).
- `GET v/<id>.json`: the clip's status; polled until it is ready.
- `v/<id>`: the public phone page the QR points to.

If there is no connection, clips wait in IndexedDB on the totem and upload later. «ΣΤΗΝ ΟΥΡΑ» shows how many are waiting.

## Run it locally
```
cd totem-ui
python -m http.server 8080
```
Open http://localhost:8080/booth2.html. The camera works on localhost.

There is no booth server locally, so clips stay in the queue and nothing is rendered. That is fine for working on the design. For the full flow, ask Spiros for the server link; it needs a key.

## URL options
| Option | What it does |
|---|---|
| `fx=ghost,rgb` | which filters are offered |
| `sec=3` | recording length |
| `rot=90` | camera mounted sideways |
| `mirror=0` | no mirrored preview |
| `cam=facecam` | pick a camera by name |
| `back=45` | go back to idle by itself after 45 s |
| `qr=0` | no QR; the totem plays the finished clip itself (for tests) |
| `debug=1` | show resolution and real fps |

## Files
- `booth2.html`: the screen.
- `css/booth2.css`: the styles.
- `js/booth.js`: the logic. The older `booth.html` shares this file in the scoreboard app.
- `js/vendor/qrcode.js`: the QR library.
- `assets/`: the logo, the balls, and the Fira Sans Extra Condensed fonts (OFL).
