import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

// Blobs stores immutable timetable events only. Authentication is handled
// separately with Netlify environment variables; credentials/tokens are never
// written to this store.
const STORE = getStore({ name: "sit-campus-timetable-events", consistency: "strong", region: "ap-southeast-1" });
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 1_500_000;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SECTIONS = new Set(["G", "H"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function accounts() {
  try {
    const parsed = JSON.parse(process.env.TEACHER_ACCOUNTS || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("TEACHER_ACCOUNTS must contain valid JSON.");
  }
}

function sign(payload) {
  const secret = process.env.TEACHER_TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("Set TEACHER_TOKEN_SECRET to a random secret of at least 32 characters.");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [body, signature] = token.split(".");
  const secret = process.env.TEACHER_TOKEN_SECRET;
  if (!body || !signature || !secret) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return null; }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function cleanTeacher(username, account) {
  return {
    user: username,
    name: String(account.name || username).slice(0, 80),
    subjects: Array.isArray(account.subjects) ? account.subjects.filter(x => typeof x === "string").slice(0, 100) : ["*"],
  };
}

function validBase(base) {
  return !!base && typeof base === "object" && !!base.tt && typeof base.tt === "object" &&
    DAYS.every(day => Array.isArray(base.tt[day]));
}

function validAlt(item) {
  return !!item && typeof item === "object" && typeof item.id === "string" && item.id.length <= 120 &&
    ["cancel", "change", "extra"].includes(item.type) && Number.isFinite(Number(item.s)) &&
    (item.type === "extra" || ["date", "weekly"].includes(item.scope));
}

// Non-extra alterations refer to one logical timetable slot. This means two
// editors changing the same slot conflict deterministically, while edits to
// different slots are stored independently and are never lost to whole-file
// last-write-wins overwrites. Extra classes each have their own unique id.
function targetKey(item) {
  if (item.type === "extra") return `extra:${item.id}`;
  return [item.type, item.scope || "", item.date || "", item.day || "", Number(item.s)].join(":");
}

async function readSection(section) {
  const prefix = `section-${section}/events/`;
  const { blobs } = await STORE.list({ prefix });
  const events = await Promise.all(blobs.map(async blob => {
    const value = await STORE.get(blob.key, { type: "json", consistency: "strong" });
    return value ? { ...value, _key: blob.key } : null;
  }));
  const ordered = events.filter(Boolean).sort((a, b) =>
    (Number(a.createdAt) - Number(b.createdAt)) || String(a.eventId).localeCompare(String(b.eventId))
  );
  let base = null;
  const alterations = new Map();
  for (const event of ordered) {
    if (event.kind === "base-set" && validBase(event.base)) {
      base = event.base;
    } else if (event.kind === "alt-upsert" && validAlt(event.item)) {
      alterations.set(event.target, event.item);
    } else if (event.kind === "alt-delete" && typeof event.target === "string") {
      alterations.delete(event.target);
    }
  }
  return {
    base,
    alts: [...alterations.values()],
    version: ordered.length,
    updatedAt: ordered.length ? new Date(ordered[ordered.length - 1].createdAt).toISOString() : null,
  };
}

async function writeEvent(section, eventId, event) {
  const key = `section-${section}/events/${eventId}`;
  const result = await STORE.setJSON(key, {
    ...event,
    eventId,
    createdAt: Date.now(),
  }, { onlyIfNew: true });
  // A duplicate event id is treated as an idempotent retry.
  return result.modified;
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.searchParams.get("action") === "me") {
        const teacher = verifyToken(req);
        return teacher
          ? json({ teacher: { user: teacher.user, name: teacher.name, subjects: teacher.subjects } })
          : json({ error: "Your teacher session has expired. Please sign in again." }, 401);
      }
      const section = url.searchParams.get("section");
      if (!SECTIONS.has(section)) return json({ error: "Choose section G or H." }, 400);
      const record = await readSection(section);
      return json({ record: record.version ? record : null });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON request." }, 400); }

    if (body.action === "login") {
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!username || !password) return json({ error: "Enter your username and password." }, 400);
      const account = accounts()[username];
      if (!account || typeof account.password !== "string" || !safeEqual(password, account.password)) {
        return json({ error: "Incorrect username or password." }, 401);
      }
      const teacher = cleanTeacher(username, account);
      const now = Math.floor(Date.now() / 1000);
      const token = sign({ ...teacher, iat: now, exp: now + TOKEN_TTL_SECONDS });
      return json({ token, teacher });
    }

    const teacher = verifyToken(req);
    if (!teacher) return json({ error: "Sign in as a teacher before publishing." }, 401);
    const section = body.section;
    if (!SECTIONS.has(section)) return json({ error: "Choose section G or H." }, 400);
    if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) {
      return json({ error: "Send between 1 and 100 timetable operations." }, 400);
    }

    const prepared = [];
    for (const op of body.operations) {
      const eventId = String(op.eventId || "");
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(eventId)) return json({ error: "Invalid change id." }, 400);
      let event;
      if (op.kind === "alt-upsert" && validAlt(op.item)) {
        event = { kind: "alt-upsert", target: targetKey(op.item), item: op.item, updatedBy: String(teacher.name || teacher.user).slice(0, 80) };
      } else if (op.kind === "alt-delete" && typeof op.target === "string" && op.target.length <= 300) {
        event = { kind: "alt-delete", target: op.target, updatedBy: String(teacher.name || teacher.user).slice(0, 80) };
      } else if (op.kind === "base-set" && validBase(op.base)) {
        event = { kind: "base-set", base: op.base, updatedBy: String(teacher.name || teacher.user).slice(0, 80) };
      } else {
        return json({ error: "One of the timetable changes is invalid." }, 400);
      }
      prepared.push({ eventId, event });
    }

    const written = [];
    for (const item of prepared) {
      const modified = await writeEvent(section, item.eventId, item.event);
      written.push({ eventId: item.eventId, modified });
    }

    const record = await readSection(section);
    return json({ written, record });
  } catch (error) {
    console.error("SIT timetable function error:", error);
    return json({ error: error.message || "Unexpected server error." }, 500);
  }
};

export const config = { path: "/.netlify/functions/timetable" };
