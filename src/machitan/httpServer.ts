import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { handleMachitanPickProof } from "./pickProofIntake.js";

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

    sendJson(response, 404, { ok: false, error: "Not found" });
  });

  server.listen(env.DELIVEREE_EXTENSION_PORT, env.DELIVEREE_EXTENSION_HOST, () => {
    console.log(`Machitan HTTP intake aktif di ${env.DELIVEREE_EXTENSION_HOST}:${env.DELIVEREE_EXTENSION_PORT} (/machitan/pick-proof).`);
  });

  return server;
}
