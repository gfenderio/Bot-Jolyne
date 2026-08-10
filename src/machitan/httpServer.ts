import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { handleMachitanPickProof } from "./pickProofIntake.js";
import { handleMachitanShipping } from "./shippingIntake.js";
import { handleWsInboxIntake } from "./wsInboxIntake.js";
import { handleAbsenRequest } from "./absenIntake.js";
import { handleMachitanPickupProof } from "./pickupProofIntake.js";
import { handleArrivalProof } from "./arrivalProofIntake.js";
import { printLabelUrl } from "../services/kyouLinks.js";
import { catatKlik } from "../services/splitPrintClickStore.js";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * Server HTTP minimal untuk menerima Pick/Pack/Archive proof dari Machitan PDA.
 * Dulu endpoint ini menumpang di server Deliveree extension (src/deliveree/extensionIntake.ts).
 * Saat direktori deliveree dihapus, server-nya ikut hilang sehingga /machitan/pick-proof
 * mati (Coolify -> 502). File ini mengembalikan endpoint tersebut secara berdiri sendiri.
 * Port tetap memakai DELIVEREE_EXTENSION_PORT (default 3001 = EXPOSE Dockerfile) agar
 * konfigurasi proxy Coolify tidak perlu diubah.
 */
export function startMachitanHttpServer(client: Client<true>) {
  const server = createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0];

    if (pathname === "/" || pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "machitan-pick-proof" });
      return;
    }

    if (pathname === "/machitan/pick-proof") {
      // handler self-contained: cek method POST + Authorization Bearer + parse body sendiri.
      handleMachitanPickProof(request, response, client).catch((error) => {
        console.error("Gagal memproses Machitan pick-proof", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling Machitan request" });
        }
      });
      return;
    }

    if (pathname === "/machitan/pickup-proof") {
      handleMachitanPickupProof(request, response, client).catch((error) => {
        console.error("Gagal memproses Machitan pickup-proof", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling pickup proof" });
        }
      });
      return;
    }

    // Bukti kirim dari layar Shipping Out. Handler-nya (shippingIntake.ts) sudah
    // lama ada tapi TIDAK PERNAH dipasang di sini, jadi setiap kiriman dari PDA
    // dijawab 404 "Not found" — orang gudang melihatnya sebagai "gagal kirim"
    // setelah datanya terlanjur dibereskan di server. Diverifikasi 10 Agu 2026:
    // /machitan/pick-proof menjawab 400 (hidup), /machitan/shipping 404 (mati).
    if (pathname === "/machitan/shipping") {
      handleMachitanShipping(request, response, client).catch((error) => {
        console.error("Gagal memproses Machitan shipping", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling shipping proof" });
        }
      });
      return;
    }

    if (pathname === "/machitan/ws-inbox") {
      handleWsInboxIntake(request, response).catch((error) => {
        console.error("Gagal memproses Machitan WS inbox", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling WS Inbox request" });
        }
      });
      return;
    }

    if (pathname === "/machitan/arrival-proof") {
      handleArrivalProof(request, response, client).catch((error) => {
        console.error("Gagal memproses Arrival proof (bukti bongkar)", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling arrival proof" });
        }
      });
      return;
    }

    // Pembelokan tautan cetak "kiriman terpisah". Bukan endpoint data: dia cuma
    // mencatat gudang mana yang dibuka lalu melempar ke halaman cetak yang sama
    // seperti dulu. Sengaja TANPA token — ini tautan yang diklik orang gudang
    // dari Discord, dan halaman tujuannya sendiri sudah menuntut login admin.
    // Yang bisa dilakukan orang asing di sini cuma menaruh catatan klik palsu;
    // catatan itu tidak pernah dianggap bukti cetak (lihat splitPrintClickStore).
    if (pathname.startsWith("/print/")) {
      const [, , orderId, packGroupId] = pathname.split("/");
      const tujuan = printLabelUrl(orderId ?? "", Number(packGroupId));
      if (!tujuan) {
        sendJson(response, 400, { ok: false, error: "Order atau pack group tidak sah" });
        return;
      }
      try {
        catatKlik(String(orderId), Number(packGroupId));
      } catch (error) {
        // Gagal mencatat TIDAK boleh menahan orang mencetak. Akibatnya cuma
        // satu: gudangnya kembali ditebak dari lokasi, seperti sebelum ini ada.
        console.error("[split-print] gagal mencatat klik cetak:", error);
      }
      response.writeHead(302, { location: tujuan });
      response.end();
      return;
    }

    if (pathname.startsWith("/machitan/absen")) {
      handleAbsenRequest(request, response, client).catch((error) => {
        console.error("Gagal memproses Machitan Absen Arrival", error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "Internal server error handling Absen Arrival request" });
        }
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  });

  server.listen(env.DELIVEREE_EXTENSION_PORT, env.DELIVEREE_EXTENSION_HOST, () => {
    console.log(`Machitan HTTP intake aktif di ${env.DELIVEREE_EXTENSION_HOST}:${env.DELIVEREE_EXTENSION_PORT} (/machitan/pick-proof).`);
  });

  return server;
}
