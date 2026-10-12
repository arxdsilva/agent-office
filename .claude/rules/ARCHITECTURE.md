# Architecture rule

## Dependency direction

`shared` ← `server`, `shared` ← `web`. `shared` imports only `zod`. **`web` never imports `server`.**

## Data path

| Do                                                                                            | Don't                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Sources call only `store.apply()` and `messages.reply()`                                      | Sources touching HTTP, WS, or each other      |
| Keep source-specific parsing in `server/src/sources/<name>.ts`                                | Put source-specific logic in `http.ts`        |
| Keep mapping functions pure and time-injected (`lineToEvent`, `layoutOffice`, `applyMessage`) | Hide I/O inside mappers                       |
| Put office organization only in `shared/src/grouping.ts` + `web/src/layout.ts`                | Sprinkle zone/row decisions across scene code |

## Public contracts — additive only

These are used by code outside this repo (other agent frameworks, installed hooks):

- `POST /api/events` body (`AgentEventSchema`)
- Inbox and reply APIs (`/api/agents/:id/inbox`, `/replies`, `/messages`)
- WebSocket `ServerMessage` shapes
- The hook's stdout JSON

| Do                                                                | Don't                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Add new **optional** fields                                       | Rename/remove fields, change types, or make an optional field required           |
| Keep the compatibility guard test (`{agentId}` alone → 202) green | Tighten validation on existing fields without a major-version note in the README |
