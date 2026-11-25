# wa-sound-sticker-maker

Make WhatsApp **sound stickers** (stickers that play audio when tapped) from a video, GIF, or image, before WhatsApp ships its own editor.

It builds the sticker on your computer, sends it to your own **Message yourself** chat, and then you favourite it and send it anywhere.

## Requirements

- macOS, Windows, or Linux
- [Node.js 20+](https://nodejs.org)
- WhatsApp on your phone

## Setup

```bash
git clone https://github.com/vinay0x/wa-sound-sticker-maker.git
cd wa-sound-sticker-maker
npm install
```

## Make a sticker

```bash
node make.mjs clip.mp4                       # video or GIF, uses its own sound
node make.mjs clip.mp4 --start 12            # start 12 seconds in
node make.mjs face.png --audio sound.mp3     # image + any audio file
```

Tip: drag a file into the terminal to paste its path.

1. **First run only:** a QR code appears. On your phone, go to WhatsApp > Settings > Linked devices > Link a device and scan it.
2. Leave the terminal open until it says **Done** (about 70 seconds).
3. On your phone, open **Message yourself**, long-press the sticker, and tap **Add to favourites**.
4. Send it from the sticker tray in any chat.

## Options

| Option | What it does |
|---|---|
| `--audio <file>` | Use this audio instead of the video's own sound |
| `--start <sec>` | Start the clip (and its sound) this many seconds in |
| `--to <phone>` | Send to this number (digits with country code) instead of yourself |
| `--dry` | Only build `last-sticker.webp` and `last-sound.ogg` without sending |

## Limits

| | Max |
|---|---|
| Sound | 10 seconds |
| Animation | 6 seconds (loops) |
| Sticker file | 500 KB (quality is lowered automatically to fit) |

## Notes

- The person receiving it needs a WhatsApp version with sound stickers. Otherwise it shows as a normal sticker with no sound.
- Sound doesn't play when the phone is on silent.
- Your login is saved in `./auth`. To unlink, delete that folder and remove the device from WhatsApp > Linked devices.
- If something breaks, run it with `WA_DEBUG=1 node make.mjs ...` and check `debug.log`.

## How it works

- WhatsApp's `StickerMessage` has field 26, an embedded `AudioMessage`. Baileys doesn't support it yet, so the script adds it at runtime.
- The sticker's EXIF JSON contains `"sound-sha256"`: the base64 SHA-256 of the OGG file.
- The audio is OGG/Opus, mono, 48 kHz. The sticker is a 512x512 animated WebP.

## Disclaimer

This uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. Using it is against WhatsApp's Terms of Service and could get your account restricted. Use it rarely, at your own risk. This project isn't affiliated with WhatsApp or Meta.
