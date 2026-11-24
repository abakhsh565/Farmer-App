# Voice messages in the Farmer ↔ Dealer chat

This is the contract the Farmer App implements on its side of the chat. The Dealer
App's backend (the `farmer_api_*` functions in its own Supabase project) implements
the other side. The two projects stay separate: nothing here copies audio into the
Farmer App's database, and no farmer session is presented to the dealer.

The Farmer App half is implemented and unit-tested. It is **inactive against any
backend until the three calls below exist**, because the mic is only drawn once
`farmer_api_voice_capability` answers `supported = true`.

## Audio format

| | |
|---|---|
| Container/codec (preferred) | `audio/mp4;codecs=opus` — recorded by iOS WKWebView |
| Fallback | `audio/webm;codecs=opus` — recorded by Android/Chromium WebView |
| Also accepted | `audio/mp4`, `audio/webm`, `audio/ogg;codecs=opus` |
| Channels / rate | mono, speech |
| Bitrate | 32 kbps (`audioBitsPerSecond: 32_000`) |
| Longest recording | 60 s (auto-stop) |
| Size guard | ≥ 900 bytes, ≤ 4 MiB |
| Typical 30 s note | ~120 kB |

The app tells the shop the mime type it recorded, and the shop must validate it
rather than infer from the file extension — `.m4a` can hold AAC or Opus.

## Calls

All three are `POST {shop}/rest/v1/rpc/{name}` with the shop's **anonymous** key as
`apikey` and bearer, and the farmer's credential as `p_token` in the body, exactly
like every other `farmer_api_*` call.

### 1. `farmer_api_voice_capability(p_token text)`

Read-only. Answers whether this shop takes voice notes.

```json
{ "supported": true }
```

A backend without the function answers `PGRST202` (HTTP 404); the app reads that as
"not supported" and hides the microphone. It does not show an error.

### 2. `farmer_api_begin_voice_upload(p_token text, p_mime_type text, p_bytes int, p_duration_ms int)`

Creates one object key and a short-lived signed upload URL, after checking the
credential belongs to a farmer of that shop.

```json
{ "upload_url": "https://<project>.supabase.co/storage/v1/object/upload/sign/voice-notes/...",
  "path": "<shop_id>/<farmer_id>/<uuid>.m4a",
  "expires_at": "2026-11-24T12:05:00Z" }
```

Requirements on the dealer side:

- reject `p_mime_type` outside the table above, `p_bytes > 4 MiB`, `p_bytes < 900`,
  `p_duration_ms > 60000`;
- the path is server-chosen — never accept a client-supplied path, which would let
  a farmer overwrite another farmer's note;
- the signed URL must be upload-only for that key (no read, no list, no overwrite).

### 3. `PUT <upload_url>` with the raw bytes

`Content-Type` = the mime type from step 2. The app reports progress from this
request only; nothing else in the flow is large enough to need it.

### 4. `farmer_api_send_voice(p_token text, p_path text, p_duration_ms int, p_mime_type text, p_bytes int)`

Verifies the object exists at `p_path`, that its size and type match, then records
the message. Returns at least `{ "id": "<uuid>" }`.

The message row must carry, for `farmer_api_thread` to render it:

| column | meaning |
|---|---|
| `direction` | `farmer` or `owner` (unchanged from text) |
| `kind` | `'voice'` |
| `body` | may be null |
| `duration_ms` | integer, the recording's length |
| `mime_type` | as sent |
| `audio_url` | **signed, short-lived read URL** for the object |

`farmer_api_thread` returns `audio_url` already signed. The app accepts
`audio_url` or `voice_url`, and `duration_ms` or `duration_seconds`; a row with no
URL still renders (duration visible, play disabled) rather than disappearing.

## Storage

A private bucket in the Dealer App's project, e.g. `voice-notes`, with:

- no public read; reads only through short-lived signed URLs;
- one object per message, path `<shop_id>/<farmer_id>/<uuid>`;
- retention: the Dealer App sets it (the Farmer App's own retention policy for
  `voice_note` is 7 days, and matching it keeps the two consistent);
- a policy that the shop's owner can read their own shop's objects, so the Dealer
  App's chat can play the note too.

Nothing is stored on the farmer's device beyond the in-memory blob: a cancelled
recording is gone, and a sent one is the shop's object.

## Failure behaviour in the app

| Failure | What the farmer sees |
|---|---|
| `PGRST202` on capability | no microphone; text chat unchanged |
| rejection at step 2 | the shop's sentence, microphone still usable |
| upload fails (network, 413, expired URL) | bubble with **retry** — re-sends the same recording, asks for a new ticket |
| step 4 fails | same retry, and no message exists on the shop's side |
| `NOT_AUTHORIZED` | credential cleared, conversation expires as it does for text |

The bubble never says "sent" unless step 4 returned success.

## What the Dealer App still needs

1. The bucket and its policies.
2. `farmer_api_voice_capability`, `farmer_api_begin_voice_upload`,
   `farmer_api_send_voice`, plus `kind`/`duration_ms`/`mime_type` on the messages
   table and a signed `audio_url` in `farmer_api_thread`.
3. Playback of an `owner` voice note in the dealer's chat, if the owner is to
   reply with voice as well (the farmer side already renders `owner` voice rows).

Until (1) and (2) exist, the Farmer App shows text chat exactly as before and no
recordings can be made or lost.
