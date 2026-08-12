# Gatherly WebSocket protocol v1

## Handshake

1. Send `POST /api/chat/websocket-tickets` with the bearer JWT.
2. Open `/api/chat/socket` using subprotocols `gatherly.chat.v1` and
   `gatherly.ticket.<ticket>` before the ticket expires.
3. The server selects only `gatherly.chat.v1`.

Production uses `wss://`. The ticket is one-use and must never be logged or
placed in a URL. The browser `Origin` must equal the configured frontend
origin.

## Commands

Every command is one JSON text message. Unknown properties are rejected.
`requestId` is a new UUID per command. `clientMessageId` identifies one
intended message and remains stable on retry. A connection joins at most one
event chat at a time.

```json
{"type":"chat.join","requestId":"1d3dc0ef-9817-4776-a5ad-e73f351a8c81","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2"}
{"type":"chat.message.send","requestId":"c7a9fc98-da56-46aa-a200-4b5269182290","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","clientMessageId":"a85eceba-2178-42be-a94a-1d652c3a4397","body":"See you there"}
{"type":"chat.typing.set","requestId":"048be633-9658-4b23-9800-e234b88c45bb","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","isTyping":true}
{"type":"chat.message.delete","requestId":"0f3874f3-fef8-423c-8d84-11cc25a9fd93","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","messageId":"362a0a87-c47f-4289-8e49-c16993b952d5"}
{"type":"chat.leave","requestId":"244a37a4-1508-43cb-8e91-d27ace03358b"}
```

Message bodies are trimmed and must contain 1–2,000 characters. Send and
delete commands require the connection to have joined the exact `eventId`.
The server rechecks current authorization for meaningful actions and
deliveries.

## Server events

The server may emit:

- `connection.ready` and `connection.refresh`
- `chat.joined` and `chat.left`
- `chat.message.accepted` and `chat.message.deleted.accepted`
- `chat.message.created` and `chat.message.deleted`
- `chat.typing.updated`
- `chat.presence.snapshot` and `chat.presence.updated`
- `error`, with a stable `error.code` and safe message

Acknowledgements and command errors carry the command's `requestId` where
available. `chat.message.accepted.data.duplicate` tells the client whether an
identical `clientMessageId` retry returned the already-committed message.

## Delivery and recovery

`chat.message.created` and `chat.message.deleted` describe PostgreSQL state.
The server commits first, then publishes an identifier-only Redis signal; each
receiver reloads the canonical row and reauthorizes its local recipients.
Typing, presence, acknowledgements, and errors are transient. WebSocket
delivery has no replay guarantee.

On reconnect, call
`GET /api/events/{eventId}/chat/messages?cursor=<cursor>&limit=<limit>` and
merge messages by server `message.id`. History is newest first by
`(createdAt, id)`. Retry an unacknowledged send with the same
`clientMessageId` and original body. Reusing it with different content is a
conflict, not an edit.

## Close codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 1000 | normal client close                       |
| 1001 | server shutdown                           |
| 1003 | binary frames are unsupported             |
| 1008 | command-rate policy violation             |
| 1009 | frame exceeds `WS_MAX_PAYLOAD_BYTES`      |
| 1011 | unexpected server/send error              |
| 1013 | server draining or outbound backpressure  |
| 4001 | connection age requires a fresh ticket    |
| 4003 | account or room authorization was revoked |

Codes 1000–1013 are standard WebSocket codes; 4001 and 4003 are Gatherly
application codes. Reconnect abnormal/retryable closures with exponential
backoff and jitter. After 4001 obtain a fresh ticket and reload REST history.
Do not reconnect after a deliberate sign-out until new credentials exist.
