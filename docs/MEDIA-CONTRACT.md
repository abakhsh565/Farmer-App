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
>
> 2026-11-27 — staging now runs `farmer_media_identity(p_token, p_shop_id default null)`
> and `farmer-media` version 7, which forwards `shop_id` and signs links on the
> project's https origin. Measured with the multi-shop QA farmer (`6b283ff4…`, four
> shops): upload with `shop_id` `200` under the named shop, without it `401` naming
> the ambiguity, unlinked shop `401 NOT_FOUND`, and the 3 000-byte voice note was
> stored, attached, signed and downloaded back byte-identical (`audio/mp4`).

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
POST {shop}/functions/v1/farmer-media?kind=voice&mime=audio/webm&duration_ms=4200&shop_id=<uuid>
Headers: apikey: <shop anon key>
         x-farmer-token: <token from farmer_api_join_shop>
         Content-Type: audio/webm
Body:    the raw bytes
```

`200 → { storage_path, content_type, size_bytes, farmer_id, duration_ms }`

Refusals: `400 VALIDATION`, `401 NOT_AUTHORIZED`, `403 NOT_LINKED`, `413 TOO_LARGE`.

**`shop_id` is required for a farmer with more than one dealer.** A farmer token names
the farmer, not the conversation; the dealer deployment resolves the folder with
`farmer_shop_scope(farmer, null)`, which raises `VALIDATION: this farmer deals with more
than one shop`, and `farmer-media` answers that as **`401 NOT_AUTHORIZED`** — the exact
failure measured on staging: `farmer_api_*` text calls succeed for every shop while
`POST farmer-media` is refused. The fix is the dealer side's, one line each:

```sql
-- farmer_media_identity gains the conversation
create or replace function public.farmer_media_identity(p_token text, p_shop_id uuid default null)
… v_shop := public.farmer_shop_scope(v_farmer, p_shop_id);
```
```ts
// farmer-media, upload branch
const { data } = await admin.rpc("farmer_media_identity", {
  p_token: farmerToken,
  p_shop_id: url.searchParams.get("shop_id"),   // null keeps the old single-shop answer
});
```

This client sends `shop_id` on every upload, so it works with both the old and the
repaired function; an old function ignores the extra parameter. Until the dealer
deployment is repaired, a farmer linked to two or more shops can send text but neither
voice nor photos — and the app must keep the conversation on screen when that upload is
refused (a refused upload is not a reason to sign the farmer out).

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
