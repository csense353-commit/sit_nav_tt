import { getStore } from "@netlify/blobs";
import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const STORE = getStore("sit-campus-timetables");
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 1_500_000;

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

function validRecord(record) {
  if (!record || typeof record !== "object" || !record.base || !record.base.tt ||
      !Array.isArray(record.alts)) return false;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days.every(day => Array.isArray(record.base.tt[day]));
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.searchParams.get("action") === "me") {
        const teacher = verifyToken(req);
        return teacher ? json({ teacher: { user: teacher.user, name: teacher.name, subjects: teacher.subjects } })
          : json({ error: "Your teacher session has expired. Please sign in again." }, 401);
      }
      const section = url.searchParams.get("section");
      if (!["G", "H"].includes(section)) return json({ error: "Choose section G or H." }, 400);
      const record = await STORE.get(`section-${section}`, { type: "json", consistency: "strong" });
      return json({ record: record || null });
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
    if (!["G", "H"].includes(section)) return json({ error: "Choose section G or H." }, 400);
    if (!validRecord(body)) return json({ error: "The timetable data is incomplete or invalid." }, 400);

    const key = `section-${section}`;
    const previous = await STORE.get(key, { type: "json", consistency: "strong" });
    const record = {
      base: body.base,
      alts: body.alts,
      version: Number(previous?.version || 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: String(teacher.name || teacher.user).slice(0, 80),
    };
    await STORE.setJSON(key, record);
    return json({ record });
  } catch (error) {
    console.error("SIT timetable function error:", error);
    return json({ error: error.message || "Unexpected server error." }, 500);
  }
};

export const config = { path: "/.netlify/functions/timetable" };
