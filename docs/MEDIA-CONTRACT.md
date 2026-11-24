# Voice notes and photos — the contract both apps implement

This is the **single** media contract for the Farmer ↔ Dealer conversation. It is the
Dealer App's own document, `docs/FARMER_MEDIA_CONTRACT.md` in `abakhsh565/Agri-shop-App`,
adopted as written: the Farmer App has no media endpoint, bucket or message column of
its own, and the Dealer App has nothing to change for this client. It replaces the
earlier ticket-based proposal this repository carried (`docs/VOICE-MESSAGES.md`),
which was never implemented on either side.

The two Supabase projects stay separate. Nothing here copies audio or images into the
Farmer App's database, and no farmer session is presented to the dealer.

> Dealer-side status: migrations `0336`/`0337` and the `farmer-media` function answer
> on staging (`bpybjrjenwccowvtrevu`). Verified by this client on 2026-11-24:
> `farmer_api_media` and `farmer_api_send_attachment` exist, `farmer-media` answers
> `401 NOT_AUTHORIZED` without a credential.

## 1. Shape of a message

The conversation is still `farmer_messages` — who said what, to whom, when. A file is
one optional row in `farmer_message_attachments`, joined by `message_id`. Text
messaging is untouched: `body` may now be empty (a voice note or photo with no caption
is a complete message) and every existing row still satisfies the check.

| | |
|---|---|
| `kind` | `voice` or `image` |
| bucket | `farmer-chat-media`, **private**, no `anon`/`authenticated` policy |
| path | `<shop_id>/<farmer_id>/<uuid>.<ext>` — chosen by the server, never by the client |
| voice duration | 1 … 600000 ms, required for `voice`, forbidden for `image` |
| size | 1 byte … 10 MB |
| mime | `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`, `image/jpeg`, `image/png`, `image/webp` |

## 2. The four calls

### 2.1 Upload the bytes

```
POST {shop}/functions/v1/farmer-media?kind=voice&mime=audio/webm&duration_ms=4200
Headers: apikey: <shop anon key>
         x-farmer-token: <token from farmer_api_join_shop>
         Content-Type: audio/webm
Body:    the raw bytes
```

`200 → { storage_path, content_type, size_bytes, farmer_id, duration_ms }`

Refusals: `400 VALIDATION`, `401 NOT_AUTHORIZED`, `403 NOT_LINKED`, `413 TOO_LARGE`.

The mime type is the **bare container**. A recorder reports `audio/webm;codecs=opus`,
and that string is refused; the app strips the parameter before sending.

### 2.2 Make it a message

```
farmer_api_send_attachment(
  p_token, p_kind, p_storage_path, p_mime_type,
  p_size_bytes, p_duration_ms, p_body
) → { id, created_at, direction: "farmer", attachment: { … } }
```

`p_duration_ms` is null for an image. `p_body` is the optional caption (≤ 2000).
The function verifies the object is under this farmer's own folder before writing a row,
so a failed upload never leaves a message pointing at nothing.

### 2.3 Read the thread's files — once per thread

```
farmer_api_media(p_token, p_shop_id := null)
→ [ { message_id, attachment_id, kind, mime_type, size_bytes,
      duration_ms, width, height, storage_path, sender, created_at } ]
```

`[]` for a conversation of plain text — never an error, so a client written for text
keeps working. The app joins these onto `farmer_api_thread`'s messages by `message_id`;
the thread itself says who said what, this says which of those carry a file.

### 2.4 Play it

```
GET {shop}/functions/v1/farmer-media?message_id=<uuid>
Headers: apikey, x-farmer-token
→ { message_id, kind, mime_type, size_bytes, duration_ms, sender, created_at,
    url, expires_in: 60 }
```

The URL is a sixty-second signature on a private object. The app asks for one when the
farmer presses play (or when a photo bubble appears), uses it immediately, and never
stores it in a message: a cached link plays today and is silent tomorrow.

## 3. Who may do what

| Caller | Credential | May |
|---|---|---|
| Farmer App (never signed in) | `x-farmer-token` | upload, and mint links for his own conversation |
| Dealer App (signed in) | `Authorization: Bearer <jwt>` | upload, and mint links for farmers linked to the active shop |

A dealer may not upload for a farmer of another shop (`403 NOT_LINKED`), and the link
call answers `404 NOT_FOUND` for "not there" and "not yours" alike, so a caller cannot
probe another conversation.

## 4. Audio format the app records

| | |
|---|---|
| Container | `audio/mp4` or `audio/webm` — whichever WebView records |
| Channels / rate | mono, speech |
| Bitrate | 32 kbps |
| Longest | 60 s (auto-stop) |
| Size guard | ≥ 900 bytes, ≤ 4 MiB |
| Typical 30 s note | ~120 kB |

## 5. Failure behaviour in the app

| Failure | What the farmer sees |
|---|---|
| capability check fails (`PGRST202`, or the function missing) | no microphone, no camera; text chat unchanged |
| upload fails (network, 413, expired credential) | bubble with **retry** — the same recording or photo, progress, and no message on the shop's side |
| `send_attachment` fails after a successful upload | retry re-uses the stored object rather than uploading again |
| `NOT_AUTHORIZED` | credential cleared, conversation expires as it does for text |

The bubble never says "sent" unless the message row was created.

## 6. What the Farmer App implements

`src/shop/api/media.ts` is the whole client: `uploadMedia`, `sendAttachment`,
`fetchShopMedia`, `mediaLink`, `mediaCapability`, `validateMedia`, plus the container
normalisation and duration formatting. `ShopApiProvider` owns the outbox (bytes,
progress, storage path, retry). `VoiceBubble` and `PhotoBubble` render from metadata and
mint a link on demand.

No endpoint, bucket or column was added on the farmer side, and none is needed on the
dealer side for this client.
