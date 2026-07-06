import { z } from "zod";
import { env } from "../config/env.js";
import type { OripaLiveInsight } from "./oripaLiveStore.js";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = `Gambar ini seharusnya screenshot ringkasan/insight siaran live Instagram atau TikTok.
Ekstrak datanya sebagai JSON persis dengan bentuk ini:
{
  "is_insight": boolean,        // true hanya jika gambar memang ringkasan/insight live
  "viewers": number | null,     // total penonton / akun yang menonton
  "peak_viewers": number | null,// penonton bersamaan tertinggi (peak concurrent)
  "duration_minutes": number | null, // durasi live dalam menit
  "comments": number | null,
  "likes": number | null,
  "shares": number | null
}
Aturan: konversi singkatan angka Indonesia/Inggris ("1,2 rb" = 1200, "4.5K" = 4500, "1 jt" = 1000000).
Durasi seperti "1:45:30" atau "1 j 45 mnt" dikonversi ke total menit (dibulatkan).
Gunakan null untuk angka yang tidak terlihat di gambar. Jangan menebak.`;

const geminiInsightSchema = z.object({
  is_insight: z.boolean(),
  viewers: z.number().nullable(),
  peak_viewers: z.number().nullable(),
  duration_minutes: z.number().nullable(),
  comments: z.number().nullable(),
  likes: z.number().nullable(),
  shares: z.number().nullable()
});

export type InsightReadFailReason =
  | "disabled"
  | "download_failed"
  | "quota_exceeded"
  | "auth_rejected"
  | "api_error"
  | "bad_response_format"
  | "not_insight"
  | "timeout";

export type InsightReadResult =
  | { ok: true; insight: OripaLiveInsight }
  | { ok: false; reason: InsightReadFailReason; message: string };

export function isInsightReaderEnabled(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

function fail(reason: InsightReadFailReason, message: string): InsightReadResult {
  return { ok: false, reason, message };
}

/**
 * Membaca angka-angka dari screenshot insight live via Gemini.
 * Tidak pernah throw — kegagalan dikembalikan sebagai { ok: false }
 * dengan alasan yang jelas supaya bisa ditampilkan apa adanya di Discord.
 */
export async function readLiveInsightFromImage(
  imageUrl: string,
  contentType?: string | null
): Promise<InsightReadResult> {
  if (!env.GEMINI_API_KEY) {
    return fail("disabled", "Pembacaan otomatis nonaktif — `GEMINI_API_KEY` belum diset di server.");
  }

  let imageBase64: string;
  let mimeType: string;

  try {
    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });

    if (!imageResponse.ok) {
      return fail(
        "download_failed",
        `Gagal mengunduh foto insight dari Discord (HTTP ${imageResponse.status}).`
      );
    }

    imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
    mimeType = contentType?.split(";")[0]?.trim() || "image/png";
  } catch (error) {
    console.error("Insight reader: gagal download foto", error);
    return fail("download_failed", "Gagal mengunduh foto insight dari Discord (jaringan/timeout).");
  }

  let response: Response;

  try {
    response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              { text: PROMPT }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0
        }
      }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    console.error("Insight reader: request Gemini gagal", error);
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return isTimeout
      ? fail("timeout", "Gemini tidak merespons dalam 60 detik — coba submit ulang.")
      : fail("api_error", "Tidak bisa terhubung ke Gemini (masalah jaringan server bot).");
  }

  if (!response.ok) {
    const bodyText = (await response.text()).slice(0, 300);
    console.error(`Insight reader: Gemini HTTP ${response.status}: ${bodyText}`);

    if (response.status === 429) {
      return fail(
        "quota_exceeded",
        "Kuota gratis Gemini habis / kena rate limit. Kuota harian reset ~14:00-15:00 WIB, atau coba lagi beberapa menit."
      );
    }

    if (response.status === 401 || response.status === 403) {
      return fail(
        "auth_rejected",
        "API key Gemini ditolak (expired/dicabut). Admin perlu cek `GEMINI_API_KEY`."
      );
    }

    return fail("api_error", `Gemini error (HTTP ${response.status}) — coba lagi nanti.`);
  }

  try {
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return fail("bad_response_format", "Gemini membalas kosong (kemungkinan foto terblokir filter).");
    }

    const parsed = geminiInsightSchema.safeParse(JSON.parse(text));

    if (!parsed.success) {
      console.error("Insight reader: JSON tidak sesuai skema.", parsed.error.issues);
      return fail("bad_response_format", "Format hasil pembacaan tidak dikenali — angka tidak bisa dipakai.");
    }

    if (!parsed.data.is_insight) {
      return fail(
        "not_insight",
        "Foto tidak dikenali sebagai screenshot insight live. Pastikan yang di-upload adalah layar ringkasan/insight setelah live, bukan foto lain."
      );
    }

    return {
      ok: true,
      insight: {
        viewers: parsed.data.viewers,
        peakViewers: parsed.data.peak_viewers,
        durationMinutes: parsed.data.duration_minutes,
        comments: parsed.data.comments,
        likes: parsed.data.likes,
        shares: parsed.data.shares
      }
    };
  } catch (error) {
    console.error("Insight reader: gagal parse respons Gemini", error);
    return fail("bad_response_format", "Respons Gemini bukan JSON valid — angka tidak bisa dipakai.");
  }
}
