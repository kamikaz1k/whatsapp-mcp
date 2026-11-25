// The REST API for programs that act on the account without an assistant, such as
// bots. It runs inside the account's Durable Object, so a refusal keeps its status
// and `code`. JSON follows the webhooks: snake_case, nulls kept, ISO 8601 UTC times.
import { z } from "zod"

import type {
  DownloadedMedia,
  GroupInfo,
  Me,
  MessageData,
  MessagesData,
  OutgoingImage,
  Presence,
  SendRequest,
  SendResult,
} from "../account"
import { errorText, RequestError, whatsappStatus } from "../errors"
import { IMAGE_TYPES, sniffImageType } from "../whatsapp/outgoing"
import type { ChatListQuery, ChatSummary, MessageQuery } from "../store/archive"
import { isoTime } from "../webhooks/events"

export interface ApiAccount {
  me(): Me
  send(request: SendRequest): Promise<SendResult>
  editMessage(chatJid: string, messageId: string, text: string): Promise<string>
  deleteMessage(chatJid: string, messageId: string): Promise<void>
  readMessage(chatJid: string, id: string, transcribeVoice: boolean): Promise<MessageData | null>
  readMessages(query: MessageQuery, transcribeVoice: boolean): Promise<MessagesData>
  listChats(query: ChatListQuery): ChatSummary[]
  markRead(chatJid: string): Promise<number>
  markMessageRead(chatJid: string, messageId: string): Promise<string>
  react(chatJid: string, messageId: string, emoji: string): Promise<void>
  downloadMedia(chatJid: string, messageId: string): Promise<DownloadedMedia>
  setPresence(chatJid: string, state: Presence): Promise<void>
  getGroupInfo(groupJid: string): Promise<GroupInfo>
}

const flag = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional()

const time = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "an ISO 8601 time, like 2026-11-19T00:00:00-03:00",
  )
  .transform((value) => Math.floor(Date.parse(value) / 1000))
  .optional()

/** A photo sent inline, as base64. 16 MB decoded is WhatsApp's limit for images. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

const ImageBody = z.object({
  base64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
  mimetype: z.enum(IMAGE_TYPES).optional(),
})

const SendBody = z
  .object({
    to: z.string().min(1),
    // With `image`, the caption; it may then be empty.
    text: z.string().max(65_536).default(""),
    image: ImageBody.optional(),
    reply_to: z.string().min(1).optional(),
    mentions: z.array(z.string().min(1)).max(256).optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .refine((body) => body.text.length > 0 || body.image !== undefined, {
    message: "send text, an image, or both",
    path: ["text"],
  })

function decodeImage(image: z.output<typeof ImageBody>): OutgoingImage {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(image.base64.replace(/^data:[^,]*,/, "")), (char) =>
      char.charCodeAt(0),
    )
  } catch {
    throw new RequestError(400, "invalid_image", "image.base64 is not valid base64")
  }
  const sniffed = sniffImageType(bytes)
  if (!sniffed) {
    throw new RequestError(400, "invalid_image", "the image is not a JPEG, PNG or WebP")
  }
  return { bytes, mimetype: sniffed }
}

const EditBody = z.object({ text: z.string().min(1).max(65_536) })

const PresenceBody = z.object({ state: z.enum(["typing", "recording", "paused"]) })

// An empty emoji takes this account's reaction away.
const ReactionBody = z.object({ emoji: z.string().max(16) })

const ChatsQuery = z.object({
  type: z.enum(["group", "direct"]).optional(),
  unread: flag,
  include_archived: flag,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

const MessagesQuery = z.object({
  since: time,
  until: time,
  sender: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  transcribe_voice: flag,
})

const MessageQueryParams = z.object({ transcribe_voice: flag })

type Route = (account: ApiAccount, request: Request, url: URL) => Promise<Response>

export async function handleApi(request: Request, account: ApiAccount): Promise<Response> {
  const url = new URL(request.url)
  try {
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment))
    const routes = routesFor(segments)
    if (!routes) throw new RequestError(404, "not_found", `no route ${url.pathname}`)
    const route = routes[request.method]
    if (!route) {
      throw new RequestError(405, "invalid_request", `${request.method} is not allowed here`)
    }
    return await route(account, request, url)
  } catch (error) {
    return errorResponse(error)
  }
}

// The handlers of a path, by HTTP method, or null when no resource has that path.
function routesFor(segments: readonly string[]): Record<string, Route> | null {
  const [resource, a, b] = segments
  switch (resource) {
    case "me":
      if (segments.length !== 1) return null
      return { GET: async (account) => Response.json(presentMe(account.me())) }
    case "messages":
      if (segments.length === 1) return { POST: sendMessage }
      if (segments.length === 4 && a && b) {
        switch (segments[3]) {
          case "read":
            return { POST: (account) => markMessageRead(account, a, b) }
          case "reaction":
            return { PUT: (account, request) => react(account, a, b, request) }
          case "media":
            return { GET: (account) => downloadMedia(account, a, b) }
          default:
            return null
        }
      }
      if (segments.length !== 3 || !a || !b) return null
      return {
        GET: (account, _request, url) => getMessage(account, a, b, url),
        PATCH: (account, request) => editMessage(account, a, b, request),
        DELETE: (account) => deleteMessage(account, a, b),
      }
    case "chats":
      if (segments.length === 1) return { GET: listChats }
      if (segments.length !== 3 || !a) return null
      switch (b) {
        case "messages":
          return { GET: (account, _request, url) => listMessages(account, a, url) }
        case "presence":
          return { POST: (account, request) => setPresence(account, a, request) }
        case "read":
          return { POST: (account) => markRead(account, a) }
        default:
          return null
      }
    case "groups":
      if (segments.length !== 2 || !a) return null
      return { GET: (account) => getGroup(account, a) }
    default:
      return null
  }
}

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) throw new RequestError(400, "invalid_request", z.prettifyError(body.error))
  return body.data
}

function parseQuery<T extends z.ZodType>(url: URL, schema: T): z.output<T> {
  const query = schema.safeParse(Object.fromEntries(url.searchParams))
  if (!query.success) throw new RequestError(400, "invalid_request", z.prettifyError(query.error))
  return query.data
}

function presentMe(me: Me): Record<string, unknown> {
  return { jid: me.jid, lid: me.lid, phone: me.phone, name: me.name, state: me.state }
}

async function sendMessage(account: ApiAccount, request: Request): Promise<Response> {
  const body = await parseBody(request, SendBody)
  const sent = await account.send({
    to: body.to,
    text: body.text,
    image: body.image ? decodeImage(body.image) : undefined,
    replyTo: body.reply_to,
    mentions: body.mentions,
    idempotencyKey: body.idempotency_key,
  })
  return Response.json(
    { chat_jid: sent.chatJid, id: sent.id, deduplicated: sent.deduplicated },
    { status: sent.deduplicated ? 200 : 201 },
  )
}

async function getMessage(
  account: ApiAccount,
  chat: string,
  id: string,
  url: URL,
): Promise<Response> {
  const query = parseQuery(url, MessageQueryParams)
  const found = await account.readMessage(chat, id, query.transcribe_voice ?? false)
  if (!found) throw new RequestError(404, "message_not_found", `message ${id} not found in ${chat}`)
  return Response.json(found)
}

async function editMessage(
  account: ApiAccount,
  chat: string,
  id: string,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request, EditBody)
  const jid = await account.editMessage(chat, id, body.text)
  return Response.json({ chat_jid: jid, id })
}

async function deleteMessage(account: ApiAccount, chat: string, id: string): Promise<Response> {
  await account.deleteMessage(chat, id)
  return new Response(null, { status: 204 })
}

async function listChats(account: ApiAccount, _request: Request, url: URL): Promise<Response> {
  const query = parseQuery(url, ChatsQuery)
  const chats = account.listChats({
    type: query.type === "group" ? "groups" : (query.type ?? "all"),
    unreadOnly: query.unread ?? false,
    includeArchived: query.include_archived ?? true,
    limit: query.limit,
    offset: query.offset,
  })
  return Response.json({
    chats: chats.map((chat) => ({
      jid: chat.jid,
      name: chat.name,
      type: chat.type,
      phone: chat.phone,
      unread_count: chat.unreadCount,
      last_message_at: chat.lastMessageAt === null ? null : isoTime(chat.lastMessageAt * 1000),
      archived: chat.archived,
      pinned: chat.pinned,
    })),
  })
}

// The newest `limit` messages in [since, until), oldest first.
async function listMessages(account: ApiAccount, chat: string, url: URL): Promise<Response> {
  const query = parseQuery(url, MessagesQuery)
  const found = await account.readMessages(
    {
      chatJid: chat,
      limit: query.limit,
      after: query.since === undefined ? undefined : query.since - 1,
      before: query.until,
      senderJid: query.sender,
    },
    query.transcribe_voice ?? false,
  )
  return Response.json(found)
}

async function setPresence(account: ApiAccount, chat: string, request: Request): Promise<Response> {
  const body = await parseBody(request, PresenceBody)
  await account.setPresence(chat, body.state)
  return new Response(null, { status: 204 })
}

async function markMessageRead(account: ApiAccount, chat: string, id: string): Promise<Response> {
  return Response.json({ chat_jid: await account.markMessageRead(chat, id), id })
}

async function react(
  account: ApiAccount,
  chat: string,
  id: string,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request, ReactionBody)
  await account.react(chat, id, body.emoji)
  return new Response(null, { status: 204 })
}

// The file itself, with its type and, for a document, the name it was sent with.
async function downloadMedia(account: ApiAccount, chat: string, id: string): Promise<Response> {
  const file = await account.downloadMedia(chat, id)
  const headers = new Headers({
    "content-type": file.mimetype,
    "content-length": String(file.bytes.length),
  })
  if (file.fileName) {
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
  }
  return new Response(file.bytes, { headers })
}

async function markRead(account: ApiAccount, chat: string): Promise<Response> {
  return Response.json({ marked: await account.markRead(chat) })
}

async function getGroup(account: ApiAccount, jid: string): Promise<Response> {
  const group = await account.getGroupInfo(jid)
  return Response.json({
    group: {
      jid: group.jid,
      name: group.subject,
      description: group.description,
      owner: group.owner,
      created_at: group.createdAt === null ? null : isoTime(group.createdAt * 1000),
      size: group.size,
      announce_only: group.announceOnly,
      restricted: group.restricted,
      addressing_mode: group.addressingMode,
      participants: group.participants.map((participant) => ({
        jid: participant.jid,
        phone: participant.phone,
        name: participant.name,
        contact_name: participant.contactName,
        profile_name: participant.profileName,
        admin: participant.admin,
      })),
    },
  })
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status })
  }
  if (whatsappStatus(error) !== null) {
    return Response.json({ error: errorText(error), code: "whatsapp_error" }, { status: 502 })
  }
  return Response.json({ error: errorText(error), code: "internal" }, { status: 500 })
}
