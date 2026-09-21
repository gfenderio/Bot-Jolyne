import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { announceBirthdays, type BirthdayPerson } from "../schedulers/birthday-now.js";

/**
 * POST /hanayo/birthday — today's admin birthdays, sent by hanayo's
 * `jolyne:birthday` command at 09:00 WIB.
 *
 * Body: `{ "date": "2026-09-21", "people": [{ "username", "name", "birthdate" }] }`
 */

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Payload terlalu besar.");
  }
  return body;
}

function parsePeople(value: unknown): BirthdayPerson[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const people: BirthdayPerson[] = [];
  for (const item of value) {
    const birthdate = String(item?.birthdate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}/.test(birthdate)) return undefined;
    people.push({
      username: String(item?.username ?? ""),
      name: String(item?.name ?? ""),
      birthdate
    });
  }
  return people;
}

export async function handleBirthdayPush(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  let date = "";
  let people: BirthdayPerson[] | undefined;
  try {
    const parsed = JSON.parse((await readBody(request)) || "{}");
    date = String(parsed.date ?? "");
    people = parsePeople(parsed.people);
  } catch {
    sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah" });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !people) {
    sendJson(response, 400, { ok: false, error: "date (YYYY-MM-DD) dan people wajib diisi" });
    return;
  }

  const status = await announceBirthdays(client, date, people);
  if (status === "wrong-date") {
    sendJson(response, 409, { ok: false, error: `Tanggal ${date} bukan hari ini (WIB)` });
    return;
  }
  if (status === "no-channel") {
    sendJson(response, 500, { ok: false, error: "Channel birthday tidak bisa dikirimi pesan" });
    return;
  }
  sendJson(response, 200, { ok: true, status });
}
